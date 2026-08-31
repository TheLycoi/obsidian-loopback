/*
The Obsidian-facing half of PDF capture (TCK-073): picks a file under
sources/, reads it, and calls straight into pdf-source.ts (TCK-072) for
extraction, the manual capture builder, and automatic highlight mode. This
is the only file that touches the vault, a modal, or a Notice for either
path; pdf-source.ts itself stays exactly as tested, with no dependency on
the Obsidian API.

Two commands live here. Manual capture (runPdfCaptureCommand) mirrors
captureSelection in main.ts as closely as a PDF allows: pick the file, pick
the page, supply the passage, get a capture block in the inbox, no model
call. It needs two dialogs instead of a selection because a PDF, unlike an
open note, has no cursor and no highlight the plugin can read on its own;
that is the extra cost decision 6 asks to be justified, and it buys the
same "works with no API key, works during an outage" property capture
selection has. Automatic highlight mode (runAutomaticHighlightCommand)
proposes spans across a whole document through a HighlightAdapter and turns
every grounded one into a capture; every capture it produces is identical
in shape and status to a manual one, so it goes through the same draft,
lint, and review path and reaches Anki only if a human approves the card
drafted from it. Nothing here calls addNote; export-flow.ts keeps that one
call site.

Importing pdf-worker-setup.ts here, for its side effect, is what makes
extraction possible at all in a running Obsidian instance rather than only
under the Node test runner; see that file's own comment for why.
*/

import "./pdf-worker-setup";

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import { serializeCapture } from "./capture-format";
import {
	buildGroundedRawSourceCapture,
	extractPdfPages,
	proposeRawSourceCaptures,
	RawSourceSelectionError,
	type AutomaticHighlightResult,
	type GroundedCapture,
	type HighlightAdapter,
	type PdfPage,
} from "./pdf-source";
import { MAX_PENDING_DRAFTS } from "./review-queue";
import { shouldRefuseCapture } from "./review-orchestrator";
import type { LoopbackSettings } from "./settings";

const REFUSAL_NOTICE = `Loopback: capture refused. More than ${MAX_PENDING_DRAFTS} drafts are pending review. Open the review queue and clear some before capturing more.`;

/** Every PDF under sources/, the vault's immutable raw collection. Nothing outside it is ever offered here; that boundary is pdf-source.ts's own, enforced again at capture time by buildRawSourceCapture. */
function listPdfSources(app: App): TFile[] {
	return app.vault.getFiles().filter((file) => file.path.startsWith("sources/") && file.extension.toLowerCase() === "pdf");
}

async function extractPagesForFile(app: App, file: TFile): Promise<PdfPage[]> {
	const buffer = await app.vault.readBinary(file);
	return extractPdfPages(new Uint8Array(buffer));
}

/** Create the inbox file on first capture, otherwise append. Mirrors LoopbackPlugin.appendToInbox in main.ts exactly, kept local rather than shared, the same way review-orchestrator.ts keeps its own small readInbox rather than importing main.ts's. */
async function appendCaptureBlock(app: App, inboxPath: string, block: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(inboxPath);
	if (!existing) {
		await app.vault.create(inboxPath, block);
		return;
	}
	if (existing instanceof TFile) {
		await app.vault.append(existing, "\n" + block);
	}
}

/** Picks one PDF out of sources/. First dialog of two for manual capture, the only dialog before the optional-guidance prompt for automatic mode. */
class PdfFilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		private readonly onPick: (file: TFile) => void
	) {
		super(app);
		this.setPlaceholder("Pick a PDF under sources/");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/** Second and last dialog for manual capture: a page number and the passage on it. */
class PdfPassageModal extends Modal {
	private pageValue = "";
	private quoteValue = "";

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly onSubmit: (page: number, quote: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: `Capture from ${this.file.path}` });

		new Setting(contentEl).setName("Page").addText((text) => {
			text.setPlaceholder("1").onChange((value) => {
				this.pageValue = value;
			});
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			window.setTimeout(() => text.inputEl.focus());
		});

		new Setting(contentEl)
			.setName("Passage")
			.setDesc("The exact quoted passage, reproduced verbatim from that page.")
			.addTextArea((textarea) => {
				textarea.setPlaceholder("Paste or type the passage here.");
				textarea.onChange((value) => {
					this.quoteValue = value;
				});
				textarea.inputEl.rows = 6;
				textarea.inputEl.addClass("loopback-pdf-quote");
			});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Capture")
				.setCta()
				.onClick(() => {
					const page = Number(this.pageValue);
					const quote = this.quoteValue;
					this.close();
					this.onSubmit(page, quote);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Optional guidance before automatic highlight mode runs. Left blank, the adapter proposes freely; per decision 14, nothing here or downstream skips the grounding check or the human gate. */
class HighlightPromptModal extends Modal {
	private promptValue = "";

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly onSubmit: (prompt: string | undefined) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: `Automatic highlight: ${this.file.path}` });
		contentEl.createEl("p", {
			text: "Every proposed span is checked against the page it names before it becomes a capture. Nothing reaches Anki without a separate approval in the review queue.",
			cls: "loopback-pdf-highlight-notice",
		});

		new Setting(contentEl)
			.setName("Guidance, optional")
			.setDesc("Tells the model what to look for. Leave blank to let it propose freely.")
			.addText((text) => {
				text.setPlaceholder("for example: find the definitions").onChange((value) => {
					this.promptValue = value;
				});
				window.setTimeout(() => text.inputEl.focus());
			});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Propose")
				.setCta()
				.onClick(() => {
					const trimmed = this.promptValue.trim();
					this.close();
					this.onSubmit(trimmed.length > 0 ? trimmed : undefined);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Manual PDF capture, per decision 6's latency reasoning: no model call, no
 * network call, just two short dialogs and a write to the inbox, exactly
 * like captureSelection except a PDF needs a file and a page where an open
 * note already has both. Reuses the same 50-pending-draft refusal guard
 * captureSelection checks in main.ts, since decision 5's ceiling applies to
 * every capture path, not just the Markdown one.
 */
export async function runPdfCaptureCommand(app: App, settings: LoopbackSettings): Promise<void> {
	if (await shouldRefuseCapture(app, settings)) {
		new Notice(REFUSAL_NOTICE);
		return;
	}

	const files = listPdfSources(app);
	if (files.length === 0) {
		new Notice("Loopback: no PDF found under sources/.");
		return;
	}

	new PdfFilePickerModal(app, files, (file) => {
		void (async () => {
			let pages: PdfPage[];
			try {
				pages = await extractPagesForFile(app, file);
			} catch (error) {
				const message = error instanceof Error ? error.message : "unknown error";
				new Notice(`Loopback: could not read ${file.path} (${message}).`);
				return;
			}

			new PdfPassageModal(app, file, (page, quote) => {
				void (async () => {
					let grounded: GroundedCapture;
					try {
						grounded = buildGroundedRawSourceCapture({ sourcePath: file.path, page, quote }, pages);
					} catch (error) {
						const message = error instanceof RawSourceSelectionError ? error.message : "Loopback: could not build a capture from that input.";
						new Notice(message);
						return;
					}

					await appendCaptureBlock(app, settings.inboxPath, serializeCapture(grounded.capture));
					if (grounded.grounded) {
						new Notice(`Loopback: capture saved to ${settings.inboxPath}.`);
					} else {
						new Notice(
							`Loopback: capture saved to ${settings.inboxPath}, but the quote could not be verified against page ${page}'s extracted text. It was still saved; check it before drafting.`
						);
					}
				})();
			}).open();
		})();
	}).open();
}

/**
 * Automatic highlight mode, per decision 14. Proposes spans across a whole
 * PDF through adapter, keeps only the ones grounded in the page they claim
 * to come from (proposeRawSourceCaptures does this, not this file), and
 * appends every resulting capture to the inbox with status "captured,"
 * identical to a manual highlight. From there it is indistinguishable from
 * any other capture: the same draft, lint, and review path, reaching Anki
 * only if a human approves the card drafted from it.
 *
 * The 50-pending-draft guard is checked once, before the batch starts, not
 * once per proposed span. A batch that lands while the count is under the
 * ceiling can still push it over; the next capture attempt after that,
 * manual or automatic, is the one that gets refused, which matches
 * shouldRefuseCapture's own contract of refusing the capture that would
 * cross the line rather than undoing ones already written.
 */
export async function runAutomaticHighlightCommand(app: App, settings: LoopbackSettings, adapter: HighlightAdapter): Promise<void> {
	if (await shouldRefuseCapture(app, settings)) {
		new Notice(REFUSAL_NOTICE);
		return;
	}

	const files = listPdfSources(app);
	if (files.length === 0) {
		new Notice("Loopback: no PDF found under sources/.");
		return;
	}

	new PdfFilePickerModal(app, files, (file) => {
		new HighlightPromptModal(app, file, (prompt) => {
			void runAutomaticHighlightOn(app, settings, file, adapter, prompt);
		}).open();
	}).open();
}

async function runAutomaticHighlightOn(
	app: App,
	settings: LoopbackSettings,
	file: TFile,
	adapter: HighlightAdapter,
	prompt: string | undefined
): Promise<void> {
	let pages: PdfPage[];
	try {
		pages = await extractPagesForFile(app, file);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		new Notice(`Loopback: could not read ${file.path} (${message}).`);
		return;
	}

	new Notice(`Loopback: proposing spans for ${file.path} in the background.`);

	let result: AutomaticHighlightResult;
	try {
		result = await proposeRawSourceCaptures(file.path, pages, adapter, prompt);
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		new Notice(`Loopback: automatic highlight failed (${message}).`);
		return;
	}

	if (result.captures.length === 0) {
		new Notice(`Loopback: no grounded spans proposed for ${file.path}. ${result.rejected.length} rejected.`);
		return;
	}

	const block = result.captures.map((capture) => serializeCapture(capture)).join("");
	await appendCaptureBlock(app, settings.inboxPath, block);
	new Notice(
		`Loopback: captured ${result.captures.length} span(s) from ${file.path}, rejected ${result.rejected.length}. Review them in the queue like any other capture before drafting.`
	);
}

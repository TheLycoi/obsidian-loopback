/*
Loopback: the plugin shell. Wires the commands to the modules that do the
actual work, and wires the review queue view.

Capture selection is the forward path's first step and the only piece that
has to work when everything else is broken: it reads the current editor
selection, attaches provenance, and appends a Markdown block to the inbox
file, with no network call and no model. Draft pending captures and open
review queue both build on top of it, on their own commands, so a slow
model call or a closed instance of Anki can never add latency to capture.

TCK-076 adds a fourth command, "Capture and draft selection," the one
motion the ticket exists for: highlight a passage, and the card for it
appears in the sidebar beside it. It is not a fourth independent path; it
is capture-selection, open-review-queue, and draft-pending-captures run in
that fixed order through runCaptureAndDraft in capture-and-draft-flow.ts,
which is what actually proves the order rather than trusting that this file
happens to call them in the right sequence. Capture is written to disk
before the sidebar even opens, so a passage is never at risk from whatever
happens to drafting after that. The three original commands are untouched
and still work on their own, since capturing in a lecture with no
intention of drafting yet is a real workflow this ticket does not remove.

The two PDF commands (TCK-073) are imported dynamically, inside their own
callbacks, rather than at the top of this file with everything else. That
is not a style choice: pdf-capture-command.ts pulls in pdf-source.ts, which
pulls in pdf-parse, whose browser build touches DOMMatrix and friends at
module load time, not lazily on first use. A static import here would mean
every single Obsidian startup, for every vault this plugin is ever
installed in, runs that code before anyone has touched a PDF, so a gap in
the browser environment pdf-parse assumes exists would fail the whole
plugin, capture and drafting and the review queue included, rather than
just the PDF command someone actually invoked. A dynamic import defers that
entire dependency graph to the moment "Capture from PDF" or "Automatic
highlight" is actually run, which is exactly the same reasoning that keeps
drafting off the capture path: a fragile or slow dependency earns its own
command, never a place in what has to work when everything else is broken.
*/

import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { serializeCapture, type Capture } from "./capture-format";
import { buildCaptureRecord } from "./capture-decision";
import { runCaptureAndDraft } from "./capture-and-draft-flow";
import { DEFAULT_SETTINGS, LoopbackSettings, LoopbackSettingTab } from "./settings";
import { runDraftingCommand } from "./drafting-command";
import type { DraftAdapter } from "./adapter";
import { AnthropicAdapter } from "./adapters/anthropic";
import { OpenAiCompatibleAdapter } from "./adapters/openai-compatible";
import { AnthropicHighlightAdapter } from "./adapters/anthropic-highlight";
import type { HighlightAdapter } from "./pdf-source";
import { MAX_PENDING_DRAFTS } from "./review-queue";
import { shouldRefuseCapture } from "./review-orchestrator";
import { ReviewQueueView, VIEW_TYPE_REVIEW_QUEUE } from "./review-view";

/** Build the adapter the current settings point at. Drafting only, never called from captureSelection. */
function buildDraftAdapter(settings: LoopbackSettings): DraftAdapter {
	const vaultKey = settings.apiKeySource === "vault" ? settings.vaultApiKey : undefined;

	if (settings.provider === "anthropic") {
		return new AnthropicAdapter({
			modelId: settings.modelId,
			apiKeySource: settings.apiKeySource,
			envVarName: settings.envVarName,
			vaultKey,
		});
	}

	return new OpenAiCompatibleAdapter({
		modelId: settings.modelId,
		baseUrl: settings.openAiBaseUrl,
		apiKeySource: settings.apiKeySource,
		envVarName: settings.envVarName,
		vaultKey,
	});
}

/**
 * Build the adapter automatic highlight mode calls through. Anthropic only,
 * regardless of the drafting provider setting: the design note's decision
 * 14 and the account this project runs under are both Anthropic-specific,
 * and HighlightAdapter has no OpenAI-compatible implementation to switch to
 * yet. Never called from captureSelection or from manual PDF capture,
 * neither of which makes a model call.
 */
function buildHighlightAdapter(settings: LoopbackSettings): HighlightAdapter {
	const vaultKey = settings.apiKeySource === "vault" ? settings.vaultApiKey : undefined;
	return new AnthropicHighlightAdapter({
		modelId: settings.modelId,
		apiKeySource: settings.apiKeySource,
		envVarName: settings.envVarName,
		vaultKey,
	});
}

export default class LoopbackPlugin extends Plugin {
	settings: LoopbackSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_REVIEW_QUEUE, (leaf) => new ReviewQueueView(leaf, this));

		this.addCommand({
			id: "capture-selection",
			name: "Capture selection",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "L" }],
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.captureSelection(editor, view);
			},
		});

		this.addCommand({
			id: "capture-and-draft-selection",
			name: "Capture and draft selection",
			// A distinct hotkey from capture-selection's, so both stay
			// reachable without a conflict: this one is the new one-motion
			// path, that one is still the plain, no-drafting capture a lecture
			// workflow depends on.
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.captureAndDraftSelection(editor, view);
			},
		});

		this.addCommand({
			id: "draft-pending-captures",
			name: "Draft pending captures",
			callback: () => {
				// Fire and forget: drafting is asynchronous by design and must never
				// block the command palette or the editor the way capture never does.
				void runDraftingCommand(this.app, this.settings.inboxPath, buildDraftAdapter(this.settings));
			},
		});

		this.addCommand({
			id: "open-review-queue",
			name: "Open review queue",
			callback: () => {
				void this.openReviewQueue();
			},
		});

		this.addCommand({
			id: "capture-from-pdf",
			name: "Capture from PDF",
			callback: () => {
				void (async () => {
					try {
						const { runPdfCaptureCommand } = await import("./pdf-capture-command");
						await runPdfCaptureCommand(this.app, this.settings);
					} catch (error) {
						// A failure loading or running the PDF path is reported here and
						// only here: capture-selection, drafting, and the review queue
						// never went through this import and are unaffected either way.
						const message = error instanceof Error ? error.message : "unknown error";
						new Notice(`Loopback: PDF capture failed (${message}).`);
					}
				})();
			},
		});

		this.addCommand({
			id: "automatic-highlight-pdf",
			name: "Automatic highlight (PDF)",
			callback: () => {
				void (async () => {
					try {
						const { runAutomaticHighlightCommand } = await import("./pdf-capture-command");
						await runAutomaticHighlightCommand(this.app, this.settings, buildHighlightAdapter(this.settings));
					} catch (error) {
						const message = error instanceof Error ? error.message : "unknown error";
						new Notice(`Loopback: automatic highlight failed (${message}).`);
					}
				})();
			},
		});

		this.addSettingTab(new LoopbackSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_REVIEW_QUEUE);
	}

	/**
	 * Reveal the review queue, reusing an existing leaf rather than opening a
	 * second one. An existing leaf is revealed exactly where it already is:
	 * Obsidian lets a reviewer drag a leaf between sidebars and persists that
	 * choice, and this must never fight it or reset it back to the settings
	 * default on the next capture. The settings side (left or right,
	 * reviewSidebarSide) is consulted only when a fresh leaf has to be
	 * created, which is the one moment there is no placement to respect yet.
	 * That setting exists because the right sidebar is not free real estate:
	 * a reviewer running another plugin's panel there, a chat panel say,
	 * would otherwise get the review queue forced into a sibling tab next to
	 * it, defeating the point of seeing source and cards at once.
	 */
	async openReviewQueue(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_QUEUE);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			const sideLeaf =
				this.settings.reviewSidebarSide === "left"
					? this.app.workspace.getLeftLeaf(false)
					: this.app.workspace.getRightLeaf(false);
			leaf = sideLeaf ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_REVIEW_QUEUE, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
		// Refresh the data even for an already-open leaf: opening or focusing
		// it is not enough on its own to guarantee a capture written moments
		// ago is already showing, and "never look like nothing happened" is
		// the whole point of this ticket.
		if (leaf.view instanceof ReviewQueueView) {
			await leaf.view.refresh();
		}
	}

	/** The open review queue view instance, if a leaf of that type currently exists. Used to hand a drafting failure to the sidebar rather than only a Notice. */
	private getReviewView(): ReviewQueueView | undefined {
		const [leaf] = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_QUEUE);
		return leaf && leaf.view instanceof ReviewQueueView ? leaf.view : undefined;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * The guard checks and record-building shared by captureSelection and
	 * captureAndDraftSelection: an empty selection or a refused capture (the
	 * 50-pending-draft ceiling) already showed its own Notice by the time
	 * this returns undefined, so neither caller has to decide what a missing
	 * record means or duplicate the message. Never writes anything; that
	 * stays the caller's job, which is what lets captureAndDraftSelection
	 * write, reveal, and draft in a specific order instead of this method
	 * choosing the order for it.
	 */
	private async prepareCapture(editor: Editor, view: MarkdownView): Promise<Capture | undefined> {
		const selection = editor.getSelection();
		if (selection.trim().length === 0) {
			new Notice("Loopback: nothing selected, nothing captured.");
			return undefined;
		}

		// Decision 5: an inbox that only fills is a failure mode, and the fix
		// is a hard stop, not silent auto-expiry that would destroy a captured
		// atom. This refuses the capture itself, before anything is written,
		// rather than accepting it and refusing to draft it later.
		if (await shouldRefuseCapture(this.app, this.settings)) {
			new Notice(
				`Loopback: capture refused. More than ${MAX_PENDING_DRAFTS} drafts are pending review. Open the review queue and clear some before capturing more.`
			);
			return undefined;
		}

		const sourcePath = view.file ? view.file.path : "unknown";
		const cursorLine = editor.getCursor("from").line;
		const lines: string[] = [];
		for (let line = 0; line <= cursorLine; line++) {
			lines.push(editor.getLine(line));
		}

		return buildCaptureRecord({ selectionText: selection, sourcePath, lines, cursorLine });
	}

	/** Append the selection to the inbox, or say plainly that there was nothing to capture. Drafting and the sidebar are untouched; this is the plain, no-drafting capture a lecture workflow depends on. */
	async captureSelection(editor: Editor, view: MarkdownView): Promise<void> {
		const record = await this.prepareCapture(editor, view);
		if (!record) return;

		await this.appendToInbox(serializeCapture(record));
		new Notice(`Loopback: capture saved to ${this.settings.inboxPath}`);
	}

	/**
	 * The one-motion path: capture, then reveal the sidebar, then draft, in
	 * that fixed order, via runCaptureAndDraft. Capture is written to the
	 * inbox before the sidebar even opens, so an interrupted or failed draft
	 * can never lose the passage. Drafting is started, not awaited to
	 * completion, by runCaptureAndDraft, so a slow model call cannot delay
	 * anything the reviewer is already looking at; any error it produces for
	 * this specific capture is instead handed to the sidebar once drafting
	 * finishes, so the failure is reachable there rather than only a Notice
	 * that has already scrolled away.
	 */
	async captureAndDraftSelection(editor: Editor, view: MarkdownView): Promise<void> {
		const record = await this.prepareCapture(editor, view);
		if (!record) return;

		await runCaptureAndDraft({
			capture: async () => {
				await this.appendToInbox(serializeCapture(record));
				new Notice(`Loopback: capture saved, drafting started.`);
			},
			reveal: async () => {
				await this.openReviewQueue();
			},
			draft: async () => {
				const result = await runDraftingCommand(this.app, this.settings.inboxPath, buildDraftAdapter(this.settings));
				const reviewView = this.getReviewView();
				if (!reviewView || !result) return;
				const prefix = `${record.id}: `;
				for (const message of result.errors) {
					if (message.startsWith(prefix)) {
						reviewView.reportDraftError(record.id, message.slice(prefix.length));
					}
				}
				await reviewView.refresh();
			},
		});
	}

	/** Create the inbox file on first capture, otherwise append. Vault I/O only, no network. */
	async appendToInbox(block: string): Promise<void> {
		const path = this.settings.inboxPath;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			await this.app.vault.create(path, block);
			return;
		}
		if (existing instanceof TFile) {
			await this.app.vault.append(existing, "\n" + block);
		}
	}
}

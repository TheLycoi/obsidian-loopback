/*
Loopback: the plugin shell. Wires the commands to the modules that do the
actual work, and wires the review queue view.

Capture selection is the forward path's first step and the only piece that
has to work when everything else is broken: it reads the current editor
selection, attaches provenance, and appends a Markdown block to the inbox
file, with no network call and no model. Draft pending captures and open
review queue both build on top of it, on their own commands, so a slow
model call or a closed instance of Anki can never add latency to capture.

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
import { serializeCapture } from "./capture-format";
import { buildCaptureRecord } from "./capture-decision";
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

	/** Reveal the review queue in the right sidebar, reusing an existing leaf rather than opening a second one. */
	async openReviewQueue(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_QUEUE);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_REVIEW_QUEUE, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Append the selection to the inbox, or say plainly that there was nothing to capture. */
	async captureSelection(editor: Editor, view: MarkdownView): Promise<void> {
		const selection = editor.getSelection();
		if (selection.trim().length === 0) {
			new Notice("Loopback: nothing selected, nothing captured.");
			return;
		}

		// Decision 5: an inbox that only fills is a failure mode, and the fix
		// is a hard stop, not silent auto-expiry that would destroy a captured
		// atom. This refuses the capture itself, before anything is written,
		// rather than accepting it and refusing to draft it later.
		if (await shouldRefuseCapture(this.app, this.settings)) {
			new Notice(
				`Loopback: capture refused. More than ${MAX_PENDING_DRAFTS} drafts are pending review. Open the review queue and clear some before capturing more.`
			);
			return;
		}

		const sourcePath = view.file ? view.file.path : "unknown";
		const cursorLine = editor.getCursor("from").line;
		const lines: string[] = [];
		for (let line = 0; line <= cursorLine; line++) {
			lines.push(editor.getLine(line));
		}

		const record = buildCaptureRecord({ selectionText: selection, sourcePath, lines, cursorLine });

		await this.appendToInbox(serializeCapture(record));
		new Notice(`Loopback: capture saved to ${this.settings.inboxPath}`);
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

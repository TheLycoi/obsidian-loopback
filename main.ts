/*
Loopback: the plugin shell. Wires three commands to the modules that do the
actual work, and wires the review queue view.

Capture selection is the forward path's first step and the only piece that
has to work when everything else is broken: it reads the current editor
selection, attaches provenance, and appends a Markdown block to the inbox
file, with no network call and no model. Draft pending captures and open
review queue both build on top of it, on their own commands, so a slow
model call or a closed instance of Anki can never add latency to capture.
*/

import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { Capture, generateCaptureId, serializeCapture } from "./capture-format";
import { DEFAULT_SETTINGS, LoopbackSettings, LoopbackSettingTab } from "./settings";
import { runDraftingCommand } from "./drafting-command";
import type { DraftAdapter } from "./adapter";
import { AnthropicAdapter } from "./adapters/anthropic";
import { OpenAiCompatibleAdapter } from "./adapters/openai-compatible";
import { MAX_PENDING_DRAFTS } from "./review-queue";
import { shouldRefuseCapture } from "./review-orchestrator";
import { ReviewQueueView, VIEW_TYPE_REVIEW_QUEUE } from "./review-view";

const HEADING_PATTERN = /^#{1,6}\s+.+/;

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
		const location = this.resolveLocation(editor);

		const capture: Capture = {
			id: generateCaptureId(),
			status: "captured",
			captured: new Date().toISOString(),
			source: sourcePath,
			location,
			quote: selection,
		};

		await this.appendToInbox(serializeCapture(capture));
		new Notice(`Loopback: capture saved to ${this.settings.inboxPath}`);
	}

	/** The nearest heading above the selection, text only, or a 1-indexed line number when there is none. */
	resolveLocation(editor: Editor): string {
		const from = editor.getCursor("from");
		for (let line = from.line; line >= 0; line--) {
			const text = editor.getLine(line);
			if (HEADING_PATTERN.test(text)) {
				return text.replace(/^#{1,6}\s+/, "");
			}
		}
		return `line ${from.line + 1}`;
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

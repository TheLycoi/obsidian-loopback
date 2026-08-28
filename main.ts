/*
Loopback: capture selection.

This is the forward path's first step and the only piece that has to work
when everything else is broken. It reads the current editor selection,
attaches provenance, and appends a Markdown block to the inbox file. No
network call, no model, no AnkiConnect. Those arrive in later tickets.
*/

import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { Capture, generateCaptureId, serializeCapture } from "./capture-format";
import { DEFAULT_SETTINGS, LoopbackSettings, LoopbackSettingTab } from "./settings";

const HEADING_PATTERN = /^#{1,6}\s+.+/;

export default class LoopbackPlugin extends Plugin {
	settings: LoopbackSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "capture-selection",
			name: "Capture selection",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "L" }],
			editorCallback: (editor: Editor, view: MarkdownView) => {
				void this.captureSelection(editor, view);
			},
		});

		this.addSettingTab(new LoopbackSettingTab(this.app, this));
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

/*
The Obsidian-facing half of drafting: reads the inbox, calls the pure
orchestrator in drafting.ts, and appends whatever it returns. This is the
only file in the drafting path that touches the vault or shows a Notice.
Nothing here runs as part of captureSelection in main.ts, so a slow or
failing model call can never add latency to capture.
*/

import { type App, Notice, TFile } from "obsidian";
import { draftPendingCaptures } from "./drafting";
import type { DraftAdapter } from "./adapter";

export async function runDraftingCommand(app: App, inboxPath: string, adapter: DraftAdapter): Promise<void> {
	const file = app.vault.getAbstractFileByPath(inboxPath);
	if (!(file instanceof TFile)) {
		new Notice("Loopback: no inbox file to draft from yet.");
		return;
	}

	const fileContent = await app.vault.read(file);
	new Notice("Loopback: drafting started in the background.");

	try {
		const { appendText, result } = await draftPendingCaptures(fileContent, adapter);

		if (appendText.length > 0) {
			await app.vault.append(file, "\n" + appendText);
		}

		if (result.capturesProcessed === 0) {
			new Notice("Loopback: nothing pending to draft.");
		} else {
			new Notice(
				`Loopback: drafted ${result.draftsWritten} card(s), flagged ${result.draftsFlagged}, from ${result.capturesProcessed} capture(s).`
			);
		}

		if (result.errors.length > 0) {
			new Notice(`Loopback: ${result.errors.length} capture(s) failed to draft. See the console for details.`);
			for (const message of result.errors) {
				// message is already sanitized in drafting.ts: an HTTP status code
				// or a MissingApiKeyError's text, never a key value.
				console.error("Loopback drafting error:", message);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		new Notice(`Loopback: drafting failed (${message}).`);
	}
}

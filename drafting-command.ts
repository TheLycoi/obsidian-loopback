/*
The Obsidian-facing half of drafting: reads the inbox, calls the pure
orchestrator in drafting.ts, and appends whatever it returns. This is the
only file in the drafting path that touches the vault or shows a Notice.
Nothing here runs as part of captureSelection in main.ts, so a slow or
failing model call can never add latency to capture.

TCK-076 has this return the DraftingResult (or undefined when there was
nothing to run or the whole pass failed before producing one) instead of
nothing. The plain "Draft pending captures" command still ignores it, same
behavior as before. The capture-and-draft-selection path in main.ts is the
new reader: it matches result.errors against the capture id it just wrote
and hands any match to the review sidebar, since a Notice alone is not
"reachable" the way the ticket asks for.

TCK-078 wires retrieveWikiContext from wiki-retrieval.ts through to
draftPendingCaptures here, the one place in the drafting path that has an
app.vault to read from. drafting.ts itself stays Obsidian-free, per its own
header, by taking that function as a plain callback rather than reading
the vault directly.
*/

import { type App, Notice, TFile } from "obsidian";
import { draftPendingCaptures, type DraftingResult } from "./drafting";
import type { DraftAdapter } from "./adapter";
import { CURRENT_PROMPT_VERSION } from "./prompt-registry";
import { retrieveWikiContext } from "./wiki-retrieval";

export async function runDraftingCommand(app: App, inboxPath: string, adapter: DraftAdapter): Promise<DraftingResult | undefined> {
	const file = app.vault.getAbstractFileByPath(inboxPath);
	if (!(file instanceof TFile)) {
		new Notice("Loopback: no inbox file to draft from yet.");
		return undefined;
	}

	const fileContent = await app.vault.read(file);
	new Notice("Loopback: drafting started in the background.");

	try {
		const { appendText, result } = await draftPendingCaptures(fileContent, adapter, CURRENT_PROMPT_VERSION, {
			retrieveWikiContext: (capture) => retrieveWikiContext(app, capture),
		});

		if (appendText.length > 0) {
			await app.vault.append(file, "\n" + appendText);
		}

		if (result.capturesProcessed === 0) {
			new Notice("Loopback: nothing pending to draft.");
		} else {
			new Notice(
				`Loopback: drafted ${result.draftsWritten} card(s), flagged ${result.draftsFlagged}, dropped ${result.draftsDroppedByCritique} on critique, from ${result.capturesProcessed} capture(s).`
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

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown error";
		new Notice(`Loopback: drafting failed (${message}).`);
		return undefined;
	}
}

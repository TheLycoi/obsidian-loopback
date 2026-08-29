/*
Turns pending captures into candidate cards. This module never runs on the
capture path: main.ts wires it to its own command, "Draft pending
captures," so a slow or failing model call can never add latency to the
one-second capture budget. Every capture already sitting in the inbox with
status "captured" and no draft yet gets one drafting pass.

This file has no dependency on the Obsidian API. It takes the inbox file's
text and a DraftAdapter and returns text to append, so it can be unit
tested against a fake adapter with no network call.
*/

import { generateCaptureId, parseCaptures } from "./capture-format";
import { parseDrafts, serializeDraft, type DraftRecord } from "./draft-format";
import { isEmptyPassage, splitPassage } from "./passage-splitter";
import { lintDraft } from "./linter";
import type { DraftAdapter, DraftContext } from "./adapter";
import { CURRENT_PROMPT_VERSION } from "./prompt-registry";

export interface DraftingResult {
	capturesProcessed: number;
	draftsWritten: number;
	draftsFlagged: number;
	errors: string[];
}

export interface DraftingOutcome {
	/** Text to append to the inbox file. Empty when there was nothing to add. */
	appendText: string;
	result: DraftingResult;
}

/**
 * Draft every pending capture found in fileContent. Returns text to append
 * to the inbox, never a rewrite of what is already there, plus a summary.
 * A capture whose drafting call throws (a missing key, a network failure)
 * is recorded in result.errors with a sanitized message and left with no
 * draft blocks, so a later run tries it again rather than losing it silently.
 */
export async function draftPendingCaptures(
	fileContent: string,
	adapter: DraftAdapter,
	promptVersion: string = CURRENT_PROMPT_VERSION
): Promise<DraftingOutcome> {
	const captures = parseCaptures(fileContent);
	const existingDrafts = parseDrafts(fileContent);
	const alreadyDrafted = new Set(existingDrafts.map((draft) => draft.captureId));

	const blocks: string[] = [];
	const result: DraftingResult = { capturesProcessed: 0, draftsWritten: 0, draftsFlagged: 0, errors: [] };

	for (const capture of captures) {
		if (capture.status !== "captured") continue;
		if (alreadyDrafted.has(capture.id)) continue;
		if (isEmptyPassage(capture.quote)) continue;

		result.capturesProcessed += 1;
		const context: DraftContext = { source: capture.source, location: capture.location };
		const chunks = splitPassage(capture.quote);

		try {
			for (const chunk of chunks) {
				const rawDrafts = await adapter.draft(chunk, context, promptVersion);
				for (const rawDraft of rawDrafts) {
					const lintResult = lintDraft({ cardText: rawDraft.cardText, backExtra: rawDraft.backExtra });
					const record: DraftRecord = {
						id: generateCaptureId(),
						captureId: capture.id,
						status: lintResult.passed ? "draft" : "flagged",
						cardText: rawDraft.cardText,
						backExtra: rawDraft.backExtra,
						promptVersion: rawDraft.promptVersion,
						modelId: rawDraft.modelId,
						lintFailures: lintResult.failures,
					};
					blocks.push(serializeDraft(record));
					if (record.status === "draft") {
						result.draftsWritten += 1;
					} else {
						result.draftsFlagged += 1;
					}
				}
			}
		} catch (error) {
			// error.message is the only thing recorded. Both adapters build their
			// error messages from an HTTP status code or from MissingApiKeyError,
			// neither of which ever contains a key, so this path cannot leak one.
			const message = error instanceof Error ? error.message : "drafting failed for an unknown reason";
			result.errors.push(`${capture.id}: ${message}`);
		}
	}

	return { appendText: blocks.join(""), result };
}

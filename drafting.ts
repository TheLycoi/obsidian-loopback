/*
Turns pending captures into candidate cards. This module never runs on the
capture path: main.ts wires it to its own command, "Draft pending
captures," so a slow or failing model call can never add latency to the
one-second capture budget. Every capture already sitting in the inbox with
status "captured" and no draft yet gets one drafting pass.

This file has no dependency on the Obsidian API. It takes the inbox file's
text and a DraftAdapter and returns text to append, so it can be unit
tested against a fake adapter with no network call.

TCK-078 adds two things on top of the single draft-and-lint pass this file
used to run. First, wiki context: an optional retrieveWikiContext callback
supplies the source page's own text, its existing seeds and cards, and a
small set of related pages, which ride along on DraftContext into both
model calls below. This file stays Obsidian-free by taking that callback
as a plain function rather than reading app.vault itself; wiki-retrieval.ts
is the real implementation, and it is the caller (drafting-command.ts) that
wires it in. Second, a self-critique pass: every card the draft pass
proposes is graded a second time, through the same one-method
DraftAdapter, before the linter ever sees it. The order is fixed and does
not change: draft, then critique, then the deterministic linter, which
runs regardless of what either model call thought of its own output and
can still reject a card both passes approved.
*/

import { generateCaptureId, parseCaptures, type Capture } from "./capture-format";
import { parseDrafts, serializeDraft, type DraftRecord } from "./draft-format";
import { isEmptyPassage, splitPassage } from "./passage-splitter";
import { lintDraft } from "./linter";
import type { DraftAdapter, DraftContext } from "./adapter";
import { CURRENT_PROMPT_VERSION, CURRENT_CRITIQUE_PROMPT_VERSION } from "./prompt-registry";
import { buildCritiqueInput } from "./critique";
import type { WikiContext } from "./wiki-context";

export interface DraftingResult {
	capturesProcessed: number;
	draftsWritten: number;
	draftsFlagged: number;
	/** Cards the critique pass dropped outright: it returned zero elements, so nothing was written for that candidate at all. */
	draftsDroppedByCritique: number;
	errors: string[];
}

export interface DraftingOutcome {
	/** Text to append to the inbox file. Empty when there was nothing to add. */
	appendText: string;
	result: DraftingResult;
}

export interface DraftingOptions {
	/** The critique pass's prompt version. Defaults to CURRENT_CRITIQUE_PROMPT_VERSION. */
	critiquePromptVersion?: string;
	/**
	 * Resolves one capture's wiki context. Optional: a caller with nothing to
	 * read wiki context from (a test, or a future headless run) still drafts,
	 * just without it, the same as before this ticket. wiki-retrieval.ts is
	 * the real, Obsidian-facing implementation; this file only calls whatever
	 * function it is handed.
	 */
	retrieveWikiContext?: (capture: Capture) => Promise<WikiContext>;
}

function buildDraftContext(capture: Capture, wikiContext: WikiContext | undefined): DraftContext {
	const context: DraftContext = { source: capture.source, location: capture.location };
	if (wikiContext?.sourcePageText) context.sourcePageText = wikiContext.sourcePageText;
	if (wikiContext?.existingCards) context.existingCards = wikiContext.existingCards;
	if (wikiContext?.relatedPages) context.relatedPages = wikiContext.relatedPages;
	return context;
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
	promptVersion: string = CURRENT_PROMPT_VERSION,
	options: DraftingOptions = {}
): Promise<DraftingOutcome> {
	const critiquePromptVersion = options.critiquePromptVersion ?? CURRENT_CRITIQUE_PROMPT_VERSION;
	const captures = parseCaptures(fileContent);
	const existingDrafts = parseDrafts(fileContent);
	const alreadyDrafted = new Set(existingDrafts.map((draft) => draft.captureId));

	const blocks: string[] = [];
	const result: DraftingResult = {
		capturesProcessed: 0,
		draftsWritten: 0,
		draftsFlagged: 0,
		draftsDroppedByCritique: 0,
		errors: [],
	};

	for (const capture of captures) {
		if (capture.status !== "captured") continue;
		if (alreadyDrafted.has(capture.id)) continue;
		if (isEmptyPassage(capture.quote)) continue;

		result.capturesProcessed += 1;
		const wikiContext = options.retrieveWikiContext ? await options.retrieveWikiContext(capture) : undefined;
		const context = buildDraftContext(capture, wikiContext);
		const chunks = splitPassage(capture.quote);

		try {
			for (const chunk of chunks) {
				const rawDrafts = await adapter.draft(chunk, context, promptVersion);
				for (const rawDraft of rawDrafts) {
					const critiqueInput = buildCritiqueInput(chunk, { cardText: rawDraft.cardText, backExtra: rawDraft.backExtra });
					const critiqueResults = await adapter.draft(critiqueInput, context, critiquePromptVersion);

					if (critiqueResults.length === 0) {
						// The critique pass dropped it: not a defect a mechanical
						// check can flag, a judgment call the model made, so nothing
						// is written rather than a flagged block with no clear reason.
						result.draftsDroppedByCritique += 1;
						continue;
					}

					const revised = critiqueResults[0];
					const changed = revised.cardText !== rawDraft.cardText || revised.backExtra !== rawDraft.backExtra;

					// The passage passed here, never the wiki context, is what
					// checkAtomGrounding in linter.ts holds every cloze to. This is
					// the mechanical backstop for the rule that wiki context, and a
					// critique pass that has read it, must never turn into card
					// content: it runs regardless of what either model call did.
					const lintResult = lintDraft({ cardText: revised.cardText, backExtra: revised.backExtra, passage: chunk });

					const record: DraftRecord = {
						id: generateCaptureId(),
						captureId: capture.id,
						status: lintResult.passed ? "draft" : "flagged",
						cardText: revised.cardText,
						backExtra: revised.backExtra,
						promptVersion: rawDraft.promptVersion,
						modelId: revised.modelId,
						lintFailures: lintResult.failures,
						critiquePromptVersion,
					};
					if (changed) {
						record.originalCardText = rawDraft.cardText;
						record.originalBackExtra = rawDraft.backExtra;
					}

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

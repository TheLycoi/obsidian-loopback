/*
Turns a model's raw text response into span proposals for automatic
highlight mode. The prompt in prompts/highlight-v1.md asks for the same
"JSON array, no fence" shape draft-v1.md asks for, just with page and quote
fields instead of cardText and backExtra, so this reuses stripCodeFence from
draft-parsing.ts rather than reimplementing it.
*/

import type { SpanProposal } from "./pdf-source";
import { stripCodeFence } from "./draft-parsing";

/**
 * Parse the model's JSON array of proposed spans. Returns an empty array on
 * a malformed response rather than throwing, the same choice
 * parseModelOutput makes for drafts: a malformed response is not a reason
 * to fail the whole call, and every span here is re-checked against the
 * document's own text by proposeRawSourceCaptures regardless of what this
 * function returns.
 */
export function parseHighlightOutput(text: string): SpanProposal[] {
	const unfenced = stripCodeFence(text);
	try {
		const parsed: unknown = JSON.parse(unfenced);
		if (!Array.isArray(parsed)) return [];
		const spans: SpanProposal[] = [];
		for (const item of parsed) {
			if (
				item &&
				typeof item === "object" &&
				typeof (item as Record<string, unknown>).page === "number" &&
				typeof (item as Record<string, unknown>).quote === "string"
			) {
				spans.push({
					page: (item as Record<string, number>).page,
					quote: (item as Record<string, string>).quote,
				});
			}
		}
		return spans;
	} catch {
		return [];
	}
}

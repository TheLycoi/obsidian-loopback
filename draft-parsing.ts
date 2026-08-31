/*
Turns a model's raw text response into candidate cards. Both adapters share
this, since the prompt in prompts/draft-v1.md asks for the same output
shape regardless of which provider answered.
*/

export interface ParsedCard {
	cardText: string;
	backExtra: string;
}

/** Exported so highlight-parsing.ts, which parses the same "JSON array, no fence" shape for a different prompt, does not reimplement it. */
export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	return fenced ? fenced[1] : trimmed;
}

/**
 * Parse the model's JSON array of candidate cards. Returns an empty array
 * on a malformed response rather than throwing, since a malformed draft is
 * not a reason to lose the rest of the capture.
 */
export function parseModelOutput(text: string): ParsedCard[] {
	const unfenced = stripCodeFence(text);
	try {
		const parsed: unknown = JSON.parse(unfenced);
		if (!Array.isArray(parsed)) return [];
		const cards: ParsedCard[] = [];
		for (const item of parsed) {
			if (
				item &&
				typeof item === "object" &&
				typeof (item as Record<string, unknown>).cardText === "string" &&
				typeof (item as Record<string, unknown>).backExtra === "string"
			) {
				cards.push({
					cardText: (item as Record<string, string>).cardText,
					backExtra: (item as Record<string, string>).backExtra,
				});
			}
		}
		return cards;
	} catch {
		return [];
	}
}

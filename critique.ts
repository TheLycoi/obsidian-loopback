/*
Builds the input for a critique pass call. The critique pass reuses the
same DraftAdapter.draft method the first pass uses, decision 3 keeping the
adapter to exactly one method, so this file defines what the "passage"
argument means for that second call: not a fresh passage, but the original
passage plus the candidate card being graded, as JSON. prompts/critique-v1.md
tells the model exactly that shape to expect, and to respond in the same
[{cardText, backExtra}] array shape the first pass uses, zero elements to
drop the card, one element for the revised, or unchanged, card. Because the
shape matches, drafting.ts reuses parseModelOutput inside each adapter to
read the response; no separate parser exists for this pass.
*/

export interface CritiqueCandidate {
	cardText: string;
	backExtra: string;
}

export interface CritiqueInput {
	passage: string;
	candidate: CritiqueCandidate;
}

/** The string sent as the "passage" argument of the critique pass's adapter.draft call. */
export function buildCritiqueInput(passage: string, candidate: CritiqueCandidate): string {
	const input: CritiqueInput = {
		passage,
		candidate: { cardText: candidate.cardText, backExtra: candidate.backExtra },
	};
	return JSON.stringify(input);
}

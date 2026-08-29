/*
The narrow interface every drafting backend implements. One method, so the
adapter cannot grow into a second project living inside this one. Anthropic
and an OpenAI-compatible backend live behind it in adapters/. Everything
provider-specific, the base URL, the model id, the auth header, and the
request and response shape, stays on that side of the line.
*/

export interface DraftContext {
	/** Vault-relative path the passage was captured from. */
	source: string;
	/** The heading or line reference recorded at capture time. */
	location: string;
}

/** One candidate card, before the linter has looked at it. */
export interface Draft {
	/** The card body with cloze markup included, for example "Corpuscles are {{c1::slow}}-adapting." */
	cardText: string;
	/** The why: mechanism, source detail, or emphasis. Never just the cloze answer restated. */
	backExtra: string;
	/** The prompt version that produced this draft, so a change in card quality can be traced to a change in the prompt. */
	promptVersion: string;
	/** The model id that produced this draft. */
	modelId: string;
}

export interface DraftAdapter {
	/**
	 * Turn one passage into zero or more candidate cards. The model analyses
	 * the passage; it does not add a fact the passage does not contain. Every
	 * returned draft carries the prompt version and model id that produced it.
	 */
	draft(passage: string, context: DraftContext, promptVersion: string): Promise<Draft[]>;
}

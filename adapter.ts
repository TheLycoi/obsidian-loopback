/*
The narrow interface every drafting backend implements. One method, so the
adapter cannot grow into a second project living inside this one. Anthropic
and an OpenAI-compatible backend live behind it in adapters/. Everything
provider-specific, the base URL, the model id, the auth header, and the
request and response shape, stays on that side of the line.

TCK-078 widens DraftContext with three optional wiki fields rather than
adding a second adapter method: the retrieval that fills them lives in
wiki-context.ts (pure) and wiki-retrieval.ts (the Obsidian-facing glue that
feeds it), both outside this interface, so the adapter itself stays exactly
the one method decision 3 requires. The critique pass TCK-078 adds also
goes through this same draft method rather than a second one: it is called
again with a different promptVersion and a passage argument that carries
the candidate card to grade instead of a fresh passage. See critique.ts for
what that second call's "passage" argument actually holds.

The one rule wiki context exists to serve, never to break: the tested atom
inside a card must be present in the passage the card was drafted from.
Wiki context earns its place by improving wording, matching established
terms, and flagging a likely duplicate; it is never a source of new card
content. drafting.ts enforces this mechanically, via lintDraft's grounding
check, rather than trusting the model's own adherence to the prompt.
*/

export interface DraftContext {
	/** Vault-relative path the passage was captured from. */
	source: string;
	/** The heading or line reference recorded at capture time. */
	location: string;
	/**
	 * The source page's own text, capped by wiki-context.ts, present only
	 * when the page could be read and is non-empty. Informs wording and
	 * framing; never a source of card content on its own.
	 */
	sourcePageText?: string;
	/**
	 * The source page's existing flashcard seeds and `cards:` frontmatter,
	 * capped by wiki-context.ts, present only when the page has either.
	 * Advisory duplicate awareness only: the authoritative check stays the
	 * collection-wide AnkiConnect search at export.
	 */
	existingCards?: string;
	/**
	 * A small set of related concept or entity pages linked from the source
	 * page, capped by wiki-context.ts, present only when at least one
	 * resolved. Informs terminology and framing; never a source of card
	 * content on its own.
	 */
	relatedPages?: string;
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

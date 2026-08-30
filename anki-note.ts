/*
Turns an approved DraftRecord into the pieces an AnkiConnect addNote call
needs: which stock model it belongs to, its fields, its tags, and the
collection-wide search query used to check for a duplicate before writing
anything. No network call lives here; anki-client.ts makes the call, this
module only decides what to send.

Section 3 of CLAUDE.md is followed exactly: the existing Cloze and Basic
models, no new note type, and a wiki::<page-slug> tag on every card. No new
model is created or modified here, or anywhere in this repository.
*/

import type { DraftRecord } from "./draft-format";

export type AnkiModelName = "Cloze" | "Basic";

const CLOZE_PATTERN = /\{\{c\d+::.*?\}\}/;

/**
 * Escape a string so an Anki search treats it as literal text, not as
 * search syntax. Anki's search parser splits on an unescaped colon to find
 * a field:value pair, and treats an unescaped asterisk or underscore as a
 * wildcard, in both cases even when the surrounding text is quoted. A raw
 * cloze card carries "{{c1::atom}}", two literal colons, so without this
 * escaping a quoted phrase search for the card's own text never matches
 * the note that holds it.
 */
function escapeForAnkiSearch(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/:/g, "\\:")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/"/g, '\\"');
}

/**
 * Cloze when the card text carries cloze markup, Basic otherwise. Every
 * draft that has passed the linter is a cloze card by construction (the
 * linter requires two to four numbered clozes), so this only chooses Basic
 * for a card a reviewer has hand-edited into a plain question and answer
 * during the edit-then-approve action.
 */
export function detectModelName(cardText: string): AnkiModelName {
	return CLOZE_PATTERN.test(cardText) ? "Cloze" : "Basic";
}

/** Field values for the stock model addNote expects, keyed by that model's own default field names. */
export function buildNoteFields(record: Pick<DraftRecord, "cardText" | "backExtra">, modelName: AnkiModelName): Record<string, string> {
	if (modelName === "Cloze") {
		return { Text: record.cardText, "Back Extra": record.backExtra };
	}
	return { Front: record.cardText, Back: record.backExtra };
}

/** The page slug from a vault-relative path: the filename, without its directories or extension. */
export function derivePageSlug(sourcePath: string): string {
	const withoutDirectories = sourcePath.split("/").pop() ?? sourcePath;
	return withoutDirectories.replace(/\.[^./]+$/, "");
}

/** Every wiki card carries exactly this one tag, so a review-history hit can trace back to the page it came from. */
export function buildTags(pageSlug: string): string[] {
	return [`wiki::${pageSlug}`];
}

/**
 * The tag a raw-source card carries instead of wiki::<page-slug>, per
 * decision 14 of the design note and TCK-072: a card drafted straight from
 * a PDF under sources/ has no digest page to trace back to, so it is tagged
 * against the raw file itself. This makes the untraceable-card cost visible
 * on the card rather than silent, and is also the tag the promotion path
 * (writing the digest page, then retagging wiki::<page-slug>) looks for.
 * Both this tag and buildTags's wiki:: tag can exist across the collection
 * at once; a single card only ever carries one or the other, chosen by
 * whether its capture's source sits under sources/.
 */
export function buildSourceTags(fileSlug: string): string[] {
	return [`source::${fileSlug}`];
}

/**
 * A collection-wide search for the card's own text, exactly as Anki stores
 * it. The stored Cloze note keeps the raw "{{c1::atom}}" markup in its Text
 * field, so the search has to match that, not a stripped-down paraphrase:
 * an earlier version of this function stripped the markup before
 * searching, which meant the search looked for text no stored note ever
 * contains, and a byte-identical duplicate was never found. No deck:
 * qualifier, since decision 2 and the ticket both require the duplicate
 * search to cover the whole collection, not just the target deck.
 */
export function buildDuplicateSearchQuery(cardText: string): string {
	const escaped = escapeForAnkiSearch(cardText.trim());
	return `"${escaped}"`;
}

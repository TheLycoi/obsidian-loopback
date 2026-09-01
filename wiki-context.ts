/*
Pure retrieval logic for wiki context: turning already-fetched page text
into the bounded WikiContext bundle a DraftContext carries. This module
never touches the Obsidian API or the filesystem; wiki-retrieval.ts is the
glue that fetches the actual page text out of app.vault and calls into
this file. The split matches capture-decision.ts (pure) and the editor
reads in main.ts that feed it: the cap and the extraction rules below are
unit tested directly, with plain strings, no vault required.

The cap is stated, not left implicit. Wiki context is bounded at 3500
characters total per drafting call: 1500 for the source page's own text,
800 for its existing seeds and cards, 1200 for up to three related concept
or entity pages. A drafter fed the whole vault is slower, costs more, and
reasons worse, which is the reason to keep this small rather than letting
it grow with the vault.

Nothing extracted here is card content. It is background the drafter and
the critique pass read for wording, framing, and duplicate awareness; the
tested atom inside a cloze still has to come from the passage itself. That
rule is enforced mechanically in linter.ts, not here.
*/

export const SOURCE_PAGE_CHAR_CAP = 1500;
export const EXISTING_CARDS_CHAR_CAP = 800;
export const RELATED_PAGES_CHAR_CAP = 1200;
export const MAX_RELATED_PAGES = 3;

const TRUNCATION_MARKER = "\n[truncated]";

export interface RelatedPageText {
	/** The link path as written inside `[[...]]`, for example "concepts/spaced-repetition", with no `wiki/` prefix and no display alias. */
	path: string;
	text: string;
}

export interface WikiContext {
	/** The source page's own text, capped at SOURCE_PAGE_CHAR_CAP. Empty when the page could not be read. */
	sourcePageText: string;
	/** The page's `## Flashcard Seeds` bullets and `cards:` frontmatter, capped at EXISTING_CARDS_CHAR_CAP. Empty when the page has neither. */
	existingCards: string;
	/** Up to MAX_RELATED_PAGES related concept or entity pages linked from the source page, capped at RELATED_PAGES_CHAR_CAP total. Empty when none were found or resolved. */
	relatedPages: string;
}

function capText(text: string, cap: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= cap) return trimmed;
	if (cap <= 0) return "";
	return trimmed.slice(0, cap).trim() + TRUNCATION_MARKER;
}

/** The bullets under a page's `## Flashcard Seeds` heading, verbatim, or "" when the page has no such section. */
export function extractFlashcardSeedsSection(pageText: string): string {
	const headingPattern = /^## Flashcard Seeds[ \t]*$/m;
	const match = headingPattern.exec(pageText);
	if (!match) return "";
	const sectionStart = match.index + match[0].length;
	const rest = pageText.slice(sectionStart);
	const nextHeadingMatch = /\n(#{1,6}[ \t])/.exec(rest);
	const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
	return section.trim();
}

/** The page's `cards:` frontmatter block, verbatim, or "" when the page carries none or has no frontmatter at all. */
export function extractCardsFrontmatterBlock(pageText: string): string {
	const frontmatterPattern = /^---\n([\s\S]*?)\n---\n?/;
	const frontmatterMatch = frontmatterPattern.exec(pageText);
	if (!frontmatterMatch) return "";
	const cardsPattern = /^cards:\s*\n((?:[ \t]+\S.*\n?)*)/m;
	const cardsMatch = cardsPattern.exec(frontmatterMatch[1]);
	if (!cardsMatch) return "";
	return `cards:\n${cardsMatch[1]}`.trim();
}

/** Seeds and cards combined into one field for a DraftContext, capped at EXISTING_CARDS_CHAR_CAP. "" when the page has neither. */
export function buildExistingCardsSummary(pageText: string): string {
	const seeds = extractFlashcardSeedsSection(pageText);
	const cardsBlock = extractCardsFrontmatterBlock(pageText);
	const parts = [seeds, cardsBlock].filter((part) => part.length > 0);
	if (parts.length === 0) return "";
	return capText(parts.join("\n\n"), EXISTING_CARDS_CHAR_CAP);
}

const WIKI_LINK_PATTERN = /\[\[((?:concepts|entities)\/[^\]|#]+)[^\]]*\]\]/g;

/**
 * The wiki-relative link paths (no `wiki/` prefix, no `.md` extension) to
 * every concept or entity page linked from pageText, in first-seen order,
 * deduplicated, capped at `max`. Only `[[concepts/...]]` and
 * `[[entities/...]]` links count, per the wiki schema's link convention;
 * a link to anything else, an entry in sources/, a heading link, or an
 * external link, is not a related page.
 */
export function extractRelatedPagePaths(pageText: string, max: number = MAX_RELATED_PAGES): string[] {
	const seen = new Set<string>();
	const pattern = new RegExp(WIKI_LINK_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(pageText)) !== null) {
		const path = match[1].trim();
		if (path.length > 0) seen.add(path);
	}
	return Array.from(seen).slice(0, max);
}

/** The vault-relative file path a wiki link path resolves to. The wiki folder is the root of the link convention, so a link path gains a `wiki/` prefix and a `.md` extension to become a real vault path. */
export function resolveWikiLinkPath(linkPath: string): string {
	return `wiki/${linkPath}.md`;
}

export interface BuildWikiContextInput {
	/** The source page's raw text, or undefined when it could not be read (a raw-source capture, a page that does not exist yet, or a read failure). */
	sourcePageText?: string;
	/** Related pages already fetched by the caller, in the order they should be considered. wiki-retrieval.ts resolves these from extractRelatedPagePaths before calling in. */
	relatedPages?: RelatedPageText[];
}

/**
 * Build the bounded WikiContext a DraftContext carries, from already-fetched
 * text. Pure: no file read, no vault, no network call, so this is unit
 * tested directly with plain strings. wiki-retrieval.ts does the fetching
 * this function takes as input.
 */
export function buildWikiContext(input: BuildWikiContextInput): WikiContext {
	const rawSourcePageText = input.sourcePageText ?? "";
	const existingCards = rawSourcePageText.length > 0 ? buildExistingCardsSummary(rawSourcePageText) : "";

	const relatedPages = (input.relatedPages ?? []).slice(0, MAX_RELATED_PAGES);
	let relatedBudget = RELATED_PAGES_CHAR_CAP;
	const relatedParts: string[] = [];
	for (const page of relatedPages) {
		if (relatedBudget <= 0) break;
		const heading = `### ${page.path}\n`;
		const body = capText(page.text, relatedBudget - heading.length);
		if (body.length === 0) continue;
		const block = `${heading}${body}`;
		relatedParts.push(block);
		relatedBudget -= block.length + 2; // +2 for the "\n\n" join between blocks
	}

	return {
		sourcePageText: capText(rawSourcePageText, SOURCE_PAGE_CHAR_CAP),
		existingCards,
		relatedPages: relatedParts.join("\n\n"),
	};
}

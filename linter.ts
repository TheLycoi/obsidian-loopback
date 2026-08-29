/*
The deterministic post-call linter. No model call, no network call: every
check here is a regular expression or a word count, run against the text
the model already returned. Decision 12 in the design note puts a linter on
both sides of the model call because a funded product eleven months in
still shipped non-atomic cards that restated the source; rules that can be
checked by counting should be checked by counting rather than trusted to a
second model call.

The six checks below reimplement the idea behind AnkiLens's content
signals, and reuse the thresholds the design note already names as facts
free to reuse (the 80-word "long card" ceiling among them), without reading
or copying any of that project's code. Its repository ships no license
file, so the code is not free to copy even though the thresholds and the
approach are.
*/

export type LintFailure =
	| "cloze-count"
	| "cloze-numbering"
	| "framing-in-braces"
	| "back-extra-substring"
	| "back-extra-near-restatement"
	| "length-ceiling";

export interface LintCandidate {
	cardText: string;
	backExtra: string;
}

export interface LintResult {
	passed: boolean;
	failures: LintFailure[];
}

interface ClozeMatch {
	number: number;
	content: string;
}

const CLOZE_PATTERN = /\{\{c(\d+)::(.*?)\}\}/g;

const MIN_CLOZES = 2;
const MAX_CLOZES = 4;

/** An atom rarely needs more than this many words. Past it, the cloze is very likely carrying framing that belongs outside the braces, not the atom itself. */
const MAX_CLOZE_CONTENT_WORDS = 6;

/** Words that mark a clause rather than an atom when they show up inside a cloze: a linking verb, a relative pronoun, or a causal connector. */
const FRAMING_MARKERS = /\b(is|are|was|were|which|that|because|since|due to|such as|who)\b/i;

/** A card this long has stopped being one atom. Reused from the design note's citation of AnkiLens's "long card" signal at 80 words: the threshold is a fact, reimplemented here from scratch. */
const MAX_CARD_WORDS = 80;

/** At or above this share of shared content words, a Back Extra is repeating the front rather than adding the why. */
const NEAR_RESTATEMENT_THRESHOLD = 0.6;

const STOPWORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"to", "of", "in", "on", "at", "for", "and", "or", "but", "with",
	"this", "that", "these", "those", "it", "its", "as", "by", "from",
]);

function extractClozes(cardText: string): ClozeMatch[] {
	const matches: ClozeMatch[] = [];
	const pattern = new RegExp(CLOZE_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(cardText)) !== null) {
		matches.push({ number: parseInt(match[1], 10), content: match[2] });
	}
	return matches;
}

function stripClozeMarkup(cardText: string): string {
	return cardText.replace(/\{\{c\d+::(.*?)\}\}/g, "$1");
}

function normalizePlainText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeWords(text: string): string[] {
	const normalized = normalizePlainText(text);
	if (normalized.length === 0) return [];
	return normalized.split(" ").filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Cloze count must land in [2, 4]. */
function checkClozeCount(clozes: ClozeMatch[]): boolean {
	return clozes.length >= MIN_CLOZES && clozes.length <= MAX_CLOZES;
}

/** Cloze numbers must be exactly {1, ..., k} with no gaps, starting at c1. */
function checkClozeNumbering(clozes: ClozeMatch[]): boolean {
	if (clozes.length === 0) return false;
	const numbers = Array.from(new Set(clozes.map((cloze) => cloze.number))).sort((a, b) => a - b);
	for (let i = 0; i < numbers.length; i++) {
		if (numbers[i] !== i + 1) return false;
	}
	return true;
}

/** No cloze content reads like a clause instead of an atom: short, and free of linking-verb or connector words. */
function checkFramingInBraces(clozes: ClozeMatch[]): boolean {
	for (const cloze of clozes) {
		if (countWords(cloze.content) > MAX_CLOZE_CONTENT_WORDS) return false;
		if (FRAMING_MARKERS.test(cloze.content)) return false;
	}
	return true;
}

/** The Back Extra must not be a plain substring of the card's front text with the cloze markup removed; that would mean it adds nothing new. */
function checkBackExtraSubstring(cardText: string, backExtra: string): boolean {
	const normalizedCard = normalizePlainText(stripClozeMarkup(cardText));
	const normalizedBack = normalizePlainText(backExtra);
	if (normalizedBack.length === 0) return false;
	return !normalizedCard.includes(normalizedBack);
}

/** The Back Extra must not share most of its content words with the front; that is a paraphrase, not an explanation. */
function checkBackExtraNearRestatement(cardText: string, backExtra: string): boolean {
	const frontWords = new Set(normalizeWords(stripClozeMarkup(cardText)));
	const backWords = normalizeWords(backExtra);
	if (backWords.length === 0) return false;
	const shared = backWords.filter((word) => frontWords.has(word)).length;
	const ratio = shared / backWords.length;
	return ratio < NEAR_RESTATEMENT_THRESHOLD;
}

/** Front plus back together must stay under the length ceiling. */
function checkLengthCeiling(cardText: string, backExtra: string): boolean {
	return countWords(cardText) + countWords(backExtra) <= MAX_CARD_WORDS;
}

/** Run every check and return the failures found, if any. A draft with no failures has passed set to true. */
export function lintDraft(candidate: LintCandidate): LintResult {
	const clozes = extractClozes(candidate.cardText);
	const failures: LintFailure[] = [];

	if (!checkClozeCount(clozes)) failures.push("cloze-count");
	if (!checkClozeNumbering(clozes)) failures.push("cloze-numbering");
	if (!checkFramingInBraces(clozes)) failures.push("framing-in-braces");
	if (!checkBackExtraSubstring(candidate.cardText, candidate.backExtra)) failures.push("back-extra-substring");
	if (!checkBackExtraNearRestatement(candidate.cardText, candidate.backExtra)) failures.push("back-extra-near-restatement");
	if (!checkLengthCeiling(candidate.cardText, candidate.backExtra)) failures.push("length-ceiling");

	return { passed: failures.length === 0, failures };
}

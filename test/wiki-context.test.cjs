/*
Tests for wiki-context.ts: the pure extraction and capping logic that
turns already-fetched page text into the bounded WikiContext a DraftContext
carries. Every test here works on plain strings, no vault and no Obsidian
API, matching the split this file documents between itself and
wiki-retrieval.ts, the glue that actually reads app.vault.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	extractFlashcardSeedsSection,
	extractCardsFrontmatterBlock,
	buildExistingCardsSummary,
	extractRelatedPagePaths,
	resolveWikiLinkPath,
	buildWikiContext,
	SOURCE_PAGE_CHAR_CAP,
	EXISTING_CARDS_CHAR_CAP,
	RELATED_PAGES_CHAR_CAP,
	MAX_RELATED_PAGES,
} = require("../.test-build/wiki-context.cjs");

test("extractFlashcardSeedsSection reads the bullets under the heading, stopping at the next heading", () => {
	const page = [
		"# Spaced repetition",
		"",
		"## Definition",
		"",
		"Spaced repetition times reviews to just before forgetting.",
		"",
		"## Flashcard Seeds",
		"",
		"- [approved] Cloze: Spaced repetition times reviews to just before {{c1::forgetting}}.",
		"- [draft] Q: What does spaced repetition optimize for? / A: long-term retention.",
		"",
		"## Related concepts",
		"",
		"- [[concepts/retrieval-practice]]",
	].join("\n");

	const section = extractFlashcardSeedsSection(page);

	assert.ok(section.includes("Spaced repetition times reviews to just before {{c1::forgetting}}"));
	assert.ok(section.includes("What does spaced repetition optimize for?"));
	assert.ok(!section.includes("Related concepts"));
	assert.ok(!section.includes("retrieval-practice"));
});

test("extractFlashcardSeedsSection returns empty text for a page with no such heading", () => {
	const page = "# A page\n\nNo seeds here.\n";
	assert.equal(extractFlashcardSeedsSection(page), "");
});

test("extractFlashcardSeedsSection reads to the end of the page when the section is last", () => {
	const page = ["# A page", "", "## Flashcard Seeds", "", "- [draft] Q: X / A: Y"].join("\n");
	const section = extractFlashcardSeedsSection(page);
	assert.ok(section.includes("Q: X / A: Y"));
});

test("extractCardsFrontmatterBlock reads the cards: block out of frontmatter", () => {
	const page = [
		"---",
		"type: concept",
		"created: 2026-08-01",
		"cards:",
		"  deck: All::2 Default::Wiki",
		"  count: 2",
		"  note_ids: [111, 222]",
		"---",
		"",
		"# A page",
	].join("\n");

	const block = extractCardsFrontmatterBlock(page);

	assert.ok(block.startsWith("cards:"));
	assert.ok(block.includes("deck: All::2 Default::Wiki"));
	assert.ok(block.includes("count: 2"));
});

test("extractCardsFrontmatterBlock returns empty text for frontmatter with no cards: key", () => {
	const page = ["---", "type: concept", "created: 2026-08-01", "---", "", "# A page"].join("\n");
	assert.equal(extractCardsFrontmatterBlock(page), "");
});

test("extractCardsFrontmatterBlock returns empty text for a page with no frontmatter at all", () => {
	assert.equal(extractCardsFrontmatterBlock("# A page\n\nSome text.\n"), "");
});

test("buildExistingCardsSummary combines seeds and cards frontmatter, and is empty when a page has neither", () => {
	const withBoth = [
		"---",
		"type: concept",
		"cards:",
		"  deck: All::2 Default::Wiki",
		"  count: 1",
		"  note_ids: [1]",
		"---",
		"",
		"## Flashcard Seeds",
		"",
		"- [carded] Cloze: X is {{c1::Y}}.",
	].join("\n");

	const summary = buildExistingCardsSummary(withBoth);
	assert.ok(summary.includes("X is {{c1::Y}}"));
	assert.ok(summary.includes("deck: All::2 Default::Wiki"));

	const withNeither = "---\ntype: concept\n---\n\n# A page\n\nJust prose.\n";
	assert.equal(buildExistingCardsSummary(withNeither), "");
});

test("buildExistingCardsSummary is capped at EXISTING_CARDS_CHAR_CAP", () => {
	const longSeed = "- [draft] Q: filler / A: " + "x".repeat(EXISTING_CARDS_CHAR_CAP * 2);
	const page = `## Flashcard Seeds\n\n${longSeed}\n`;

	const summary = buildExistingCardsSummary(page);

	assert.ok(summary.length <= EXISTING_CARDS_CHAR_CAP + "\n[truncated]".length);
	assert.ok(summary.endsWith("[truncated]"));
});

test("extractRelatedPagePaths finds concepts and entities links only, deduplicated, in first-seen order", () => {
	const page = [
		"See [[concepts/spaced-repetition|spaced repetition]] and [[entities/piotr-wozniak|Piotr Wozniak]].",
		"Also [[concepts/spaced-repetition]] again, and a source link [[sources/some-source]] which does not count.",
		"And a heading link [[#Some heading]] which also does not count.",
	].join("\n");

	const paths = extractRelatedPagePaths(page, 10);

	assert.deepEqual(paths, ["concepts/spaced-repetition", "entities/piotr-wozniak"]);
});

test("extractRelatedPagePaths is capped at max, MAX_RELATED_PAGES by default", () => {
	const page = [
		"[[concepts/a]] [[concepts/b]] [[concepts/c]] [[concepts/d]] [[concepts/e]]",
	].join("\n");

	const paths = extractRelatedPagePaths(page);

	assert.equal(paths.length, MAX_RELATED_PAGES);
	assert.deepEqual(paths, ["concepts/a", "concepts/b", "concepts/c"]);
});

test("resolveWikiLinkPath adds the wiki/ prefix and .md extension the link convention omits", () => {
	assert.equal(resolveWikiLinkPath("concepts/spaced-repetition"), "wiki/concepts/spaced-repetition.md");
	assert.equal(resolveWikiLinkPath("entities/piotr-wozniak"), "wiki/entities/piotr-wozniak.md");
});

test("buildWikiContext returns all-empty fields when given nothing", () => {
	const context = buildWikiContext({});
	assert.deepEqual(context, { sourcePageText: "", existingCards: "", relatedPages: "" });
});

test("buildWikiContext caps the source page text at SOURCE_PAGE_CHAR_CAP", () => {
	const longText = "y".repeat(SOURCE_PAGE_CHAR_CAP * 3);
	const context = buildWikiContext({ sourcePageText: longText });

	assert.ok(context.sourcePageText.length <= SOURCE_PAGE_CHAR_CAP + "\n[truncated]".length);
	assert.ok(context.sourcePageText.endsWith("[truncated]"));
});

test("buildWikiContext leaves a short source page untouched, no truncation marker added", () => {
	const context = buildWikiContext({ sourcePageText: "A short page." });
	assert.equal(context.sourcePageText, "A short page.");
});

test("buildWikiContext keeps related pages within RELATED_PAGES_CHAR_CAP total across all of them", () => {
	const relatedPages = [
		{ path: "concepts/a", text: "a".repeat(RELATED_PAGES_CHAR_CAP) },
		{ path: "concepts/b", text: "b".repeat(RELATED_PAGES_CHAR_CAP) },
		{ path: "concepts/c", text: "c".repeat(RELATED_PAGES_CHAR_CAP) },
	];

	const context = buildWikiContext({ relatedPages });

	// Generous slack for the heading lines and truncation markers this adds;
	// the point of this test is that the budget is enforced, not exact byte
	// accounting, since three headings and up to three truncation markers
	// are legitimate overhead on top of the character budget itself.
	assert.ok(context.relatedPages.length <= RELATED_PAGES_CHAR_CAP + 200);
	assert.ok(context.relatedPages.includes("concepts/a"));
});

test("buildWikiContext takes at most MAX_RELATED_PAGES related pages even when more are supplied", () => {
	const relatedPages = Array.from({ length: 6 }, (_, index) => ({
		path: `concepts/page-${index}`,
		text: `Text for page ${index}.`,
	}));

	const context = buildWikiContext({ relatedPages });

	let mentioned = 0;
	for (let index = 0; index < 6; index++) {
		if (context.relatedPages.includes(`concepts/page-${index}`)) mentioned += 1;
	}
	assert.equal(mentioned, MAX_RELATED_PAGES);
});

test("buildWikiContext never puts a fact from related pages or existing cards into sourcePageText: the fields stay separate", () => {
	const context = buildWikiContext({
		sourcePageText: "The source page's own text.",
		relatedPages: [{ path: "concepts/other", text: "A fact that only lives on a related page." }],
	});

	assert.equal(context.sourcePageText, "The source page's own text.");
	assert.ok(!context.sourcePageText.includes("only lives on a related page"));
	assert.ok(context.relatedPages.includes("only lives on a related page"));
});

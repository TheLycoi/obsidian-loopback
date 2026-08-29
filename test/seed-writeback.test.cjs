/*
Tests for seed-writeback.ts: appending a Flashcard Seeds bullet to a page
and updating its cards: frontmatter block, per section 2 of CLAUDE.md and
the wiki schema's card layer. Every case here is pure text in, text out,
with no vault involved.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	buildSeedBullet,
	appendFlashcardSeed,
	updateCardsFrontmatter,
	buildMinimalSourcePage,
} = require("../.test-build/seed-writeback.cjs");

const SEED = { cardText: "The {{c1::posterior pituitary}} releases {{c2::ADH}}.", backExtra: "Stored there, made in the hypothalamus." };

test("buildSeedBullet renders a carded Cloze bullet with both the front and the why", () => {
	const bullet = buildSeedBullet(SEED);
	assert.equal(
		bullet,
		"- [carded] Cloze: The {{c1::posterior pituitary}} releases {{c2::ADH}}. (Back: Stored there, made in the hypothalamus.)"
	);
});

test("appendFlashcardSeed creates the section when the page has none yet", () => {
	const page = "---\ntype: concept\n---\n\n# Example\n\n## Definition\n\nSomething.\n";
	const updated = appendFlashcardSeed(page, SEED);

	assert.ok(updated.includes("## Flashcard Seeds"));
	assert.ok(updated.trim().endsWith(buildSeedBullet(SEED)));
	assert.ok(updated.startsWith(page.trim()), "existing content is preserved ahead of the new section");
});

test("appendFlashcardSeed adds a bullet to an existing section, before the next heading", () => {
	const page =
		"---\ntype: concept\n---\n\n# Example\n\n## Flashcard Seeds\n\n- [draft] Q: old seed? / A: old.\n\n## Related concepts\n\n- [[concepts/other]]\n";
	const updated = appendFlashcardSeed(page, SEED);

	const seedsIndex = updated.indexOf("## Flashcard Seeds");
	const relatedIndex = updated.indexOf("## Related concepts");
	const bulletIndex = updated.indexOf(buildSeedBullet(SEED));

	assert.ok(seedsIndex < bulletIndex && bulletIndex < relatedIndex, "the new bullet lands inside the Flashcard Seeds section");
	assert.ok(updated.includes("- [draft] Q: old seed? / A: old."), "the existing bullet survives");
	assert.ok(updated.includes("- [[concepts/other]]"), "the following section survives untouched");
});

test("appendFlashcardSeed adds a bullet at the end of the page when the section is already the last one", () => {
	const page = "---\ntype: concept\n---\n\n## Flashcard Seeds\n\n- [draft] Q: old? / A: old.\n";
	const updated = appendFlashcardSeed(page, SEED);

	assert.ok(updated.includes("- [draft] Q: old? / A: old."));
	assert.ok(updated.trim().endsWith(buildSeedBullet(SEED)));
});

test("updateCardsFrontmatter adds a minimal frontmatter block to a page with none", () => {
	const page = "# Example\n\nBody text.\n";
	const updated = updateCardsFrontmatter(page, { deck: "All::2 Default::Wiki", noteId: 111 });

	assert.ok(updated.startsWith("---\n"));
	assert.ok(updated.includes("cards:"));
	assert.ok(updated.includes("deck: All::2 Default::Wiki"));
	assert.ok(updated.includes("count: 1"));
	assert.ok(updated.includes("note_ids: [111]"));
	assert.ok(updated.includes("Body text."));
});

test("updateCardsFrontmatter adds a cards: block to existing frontmatter that has none", () => {
	const page = "---\ntype: concept\ncreated: 2026-08-01\n---\n\n# Example\n";
	const updated = updateCardsFrontmatter(page, { deck: "All::2 Default::Wiki", noteId: 111 });

	assert.ok(updated.includes("type: concept"));
	assert.ok(updated.includes("created: 2026-08-01"));
	assert.ok(updated.includes("count: 1"));
	assert.ok(updated.includes("note_ids: [111]"));
});

test("updateCardsFrontmatter increments count and appends the new note id to an existing block", () => {
	const page =
		"---\ntype: concept\ncards:\n  deck: All::2 Default::Wiki\n  count: 1\n  note_ids: [111]\ntags:\n  - concept\n---\n\n# Example\n";
	const updated = updateCardsFrontmatter(page, { deck: "All::2 Default::Wiki", noteId: 222 });

	assert.ok(updated.includes("count: 2"));
	assert.ok(updated.includes("note_ids: [111, 222]"));
	assert.ok(updated.includes("tags:"));
	assert.ok(updated.includes("  - concept"));
});

test("buildMinimalSourcePage produces a page satisfying the source page template's minimum frontmatter", () => {
	const page = buildMinimalSourcePage("Example Title", "2026-08-29");
	assert.equal(page, "---\ntype: source\ncreated: 2026-08-29\n---\n\n# Example Title\n");
});

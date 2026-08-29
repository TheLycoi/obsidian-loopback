/*
Tests for anki-note.ts: which stock model a card belongs to, its fields
under that model's own field names, the wiki::<page-slug> tag, and the
collection-wide duplicate search query. No network call and no new note
type is involved anywhere in this file, matching the constraint that this
repository never creates or modifies an Anki model.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	detectModelName,
	buildNoteFields,
	derivePageSlug,
	buildTags,
	buildDuplicateSearchQuery,
} = require("../.test-build/anki-note.cjs");

test("a card with cloze markup is detected as Cloze", () => {
	assert.equal(detectModelName("The {{c1::posterior pituitary}} releases {{c2::ADH}}."), "Cloze");
});

test("a card with no cloze markup is detected as Basic", () => {
	assert.equal(detectModelName("What releases ADH?"), "Basic");
});

test("buildNoteFields for Cloze uses Text and Back Extra, the model's own field names", () => {
	const fields = buildNoteFields(
		{ cardText: "The {{c1::posterior pituitary}} releases ADH.", backExtra: "Stored there, made in the hypothalamus." },
		"Cloze"
	);
	assert.deepEqual(fields, {
		Text: "The {{c1::posterior pituitary}} releases ADH.",
		"Back Extra": "Stored there, made in the hypothalamus.",
	});
});

test("buildNoteFields for Basic uses Front and Back", () => {
	const fields = buildNoteFields({ cardText: "What releases ADH?", backExtra: "The posterior pituitary." }, "Basic");
	assert.deepEqual(fields, { Front: "What releases ADH?", Back: "The posterior pituitary." });
});

test("derivePageSlug strips directories and the extension", () => {
	assert.equal(derivePageSlug("wiki/concepts/minimum-information-principle.md"), "minimum-information-principle");
	assert.equal(derivePageSlug("example.md"), "example");
});

test("buildTags produces exactly one wiki::<page-slug> tag", () => {
	assert.deepEqual(buildTags("minimum-information-principle"), ["wiki::minimum-information-principle"]);
});

test("buildDuplicateSearchQuery strips cloze markup down to the plain text and quotes it", () => {
	const query = buildDuplicateSearchQuery("The {{c1::posterior pituitary}} releases {{c2::ADH}}.");
	assert.equal(query, '"The posterior pituitary releases ADH."');
});

test("buildDuplicateSearchQuery escapes an embedded double quote so the query stays well-formed", () => {
	const query = buildDuplicateSearchQuery('A card that says "quoted text" inline.');
	assert.equal(query, '"A card that says \\"quoted text\\" inline."');
});

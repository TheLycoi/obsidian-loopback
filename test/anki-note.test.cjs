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

test("buildDuplicateSearchQuery keeps the raw cloze markup, since that is what Anki's Text field actually stores", () => {
	const query = buildDuplicateSearchQuery("The {{c1::posterior pituitary}} releases {{c2::ADH}}.");
	assert.ok(query.includes("{{c1"), "the query lost the cloze markup, so it would not match the stored note");
	assert.ok(query.includes("{{c2"));
});

// This is the TCK-070 regression guard. The old query stripped cloze
// markup down to plain text before searching, which meant a real,
// byte-identical cloze note in the collection was never found: the
// stored Text field keeps the markup, the search looked for text without
// it. Confirmed live against AnkiConnect on 2026-08-29 (see the Worker
// Log): a duplicate cloze export returned "unreachable" instead of
// "duplicate" because this exact query missed a note sitting right there.
test("buildDuplicateSearchQuery escapes the double colon in cloze markup, which the old stripped-text query never had to face", () => {
	const query = buildDuplicateSearchQuery("The {{c1::posterior pituitary}} releases {{c2::ADH}}.");
	assert.equal(query, '"The {{c1\\:\\:posterior pituitary}} releases {{c2\\:\\:ADH}}."');
});

test("buildDuplicateSearchQuery escapes an embedded double quote so the query stays well-formed", () => {
	const query = buildDuplicateSearchQuery('A card that says "quoted text" inline.');
	assert.equal(query, '"A card that says \\"quoted text\\" inline."');
});

test("buildDuplicateSearchQuery escapes a literal backslash before it escapes anything else, so the two do not collide", () => {
	const query = buildDuplicateSearchQuery("A card with a literal backslash: \\ right there.");
	assert.equal(query, '"A card with a literal backslash\\: \\\\ right there."');
});

test("buildDuplicateSearchQuery escapes asterisk and underscore, Anki's own wildcard characters, so a literal one in a card is not read as a wildcard", () => {
	const query = buildDuplicateSearchQuery("A card with *emphasis* and a_word.");
	assert.equal(query, '"A card with \\*emphasis\\* and a\\_word."');
});

test("buildDuplicateSearchQuery leaves an ordinary Basic-style question unchanged apart from the quotes", () => {
	const query = buildDuplicateSearchQuery("What releases ADH?");
	assert.equal(query, '"What releases ADH?"');
});

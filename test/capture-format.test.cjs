/*
Round-trip test for the capture block format: a capture written to text,
parsed back, must have identical fields to the original.

Run via `npm test`, which first bundles capture-format.ts to CommonJS with
esbuild (already a build dependency, so this adds nothing new to install)
and then executes this file with Node's built-in test runner. No Obsidian
API is involved, since capture-format.ts does not depend on it.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeCapture, parseCaptures, generateCaptureId, isRawSourceCapture } = require("../.test-build/capture-format.cjs");

test("a single capture round-trips with identical fields", () => {
	const capture = {
		id: generateCaptureId(new Date("2026-08-27T15:30:45.123Z")),
		status: "captured",
		captured: "2026-08-27T15:30:45.123Z",
		source: "wiki/concepts/example.md",
		location: "Some heading",
		quote: "The exact quoted passage.",
	};

	const block = serializeCapture(capture);
	const parsed = parseCaptures(block);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], capture);
});

test("a multi-line quote round-trips, including a blank line inside it", () => {
	const capture = {
		id: "20260827T153045123-ab12cd",
		status: "captured",
		captured: "2026-08-27T15:30:45.123Z",
		source: "wiki/concepts/example.md",
		location: "line 42",
		quote: "First paragraph of the passage.\n\nSecond paragraph, still quoted.",
	};

	const block = serializeCapture(capture);
	const parsed = parseCaptures(block);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], capture);
});

test("two captures appended to one file both parse back, in order", () => {
	const first = {
		id: "20260827T150000000-aaaaaa",
		status: "captured",
		captured: "2026-08-27T15:00:00.000Z",
		source: "wiki/a.md",
		location: "line 1",
		quote: "First capture.",
	};
	const second = {
		id: "20260827T150100000-bbbbbb",
		status: "captured",
		captured: "2026-08-27T15:01:00.000Z",
		source: "wiki/b.md",
		location: "A heading",
		quote: "Second capture.",
	};

	const fileContent = serializeCapture(first) + "\n" + serializeCapture(second);
	const parsed = parseCaptures(fileContent);

	assert.equal(parsed.length, 2);
	assert.deepEqual(parsed[0], first);
	assert.deepEqual(parsed[1], second);
});

/*
The cases below lock the format contract against passages that look like
format syntax. TCK-053 and TCK-054 both parse this file, so a passage that
can forge a block boundary or a field is a correctness problem for them, not
a cosmetic one. Quote lines carry a blockquote prefix, which is what makes
these safe; these tests exist so a later change cannot quietly drop it.
*/

const HOSTILE_QUOTES = {
	"a horizontal rule, which is also the block separator": "before\n---\nafter",
	"a forged capture heading and attribute line": "## Capture 20260101T000000000-forged\n\n- id: spoofed",
	"a passage that was already a blockquote": "> already quoted",
	"a passage indented like a code block": "    indented code",
	"a passage ending in a blank line": "text\n",
};

for (const [description, quote] of Object.entries(HOSTILE_QUOTES)) {
	test(`a quote containing ${description} round-trips and forges no extra block`, () => {
		const capture = {
			id: "20260827T000000000-cccccc",
			status: "captured",
			captured: "2026-08-27T00:00:00.000Z",
			source: "wiki/a.md",
			location: "A heading",
			quote,
		};

		const parsed = parseCaptures(serializeCapture(capture));

		assert.equal(parsed.length, 1);
		assert.deepEqual(parsed[0], capture);
	});
}

test("an attribute value containing a colon and a space keeps its whole value", () => {
	const capture = {
		id: "20260827T000000000-dddddd",
		status: "captured",
		captured: "2026-08-27T00:00:00.000Z",
		source: "wiki/a.md",
		location: "Note: caveat: detail",
		quote: "plain",
	};

	const parsed = parseCaptures(serializeCapture(capture));

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].location, "Note: caveat: detail");
});

test("generateCaptureId produces distinct ids on successive calls", () => {
	const ids = new Set();
	for (let i = 0; i < 50; i++) {
		ids.add(generateCaptureId());
	}
	assert.equal(ids.size, 50);
});

/*
TCK-072 extends the format with one optional attribute, page, for a
raw-source capture out of a PDF under sources/. These tests lock two
things: the extension round-trips, and a Markdown-note capture with no
page field is byte-identical to what the ten tests above already lock, so
the existing capture path is untouched by the extension.
*/

test("a raw-source capture with a page number round-trips with identical fields, page included", () => {
	const capture = {
		id: "20260830T000000000-pdf001",
		status: "captured",
		captured: "2026-08-30T00:00:00.000Z",
		source: "sources/fphar-08-00438.pdf",
		location: "page 3",
		quote: "The exact passage as it appears on that page.",
		page: 3,
	};

	const block = serializeCapture(capture);
	const parsed = parseCaptures(block);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], capture);
});

test("a Markdown-note capture with no page field serializes and parses with no page key at all", () => {
	const capture = {
		id: "20260827T153045123-ab12cd",
		status: "captured",
		captured: "2026-08-27T15:30:45.123Z",
		source: "wiki/concepts/example.md",
		location: "Some heading",
		quote: "The exact quoted passage.",
	};

	const block = serializeCapture(capture);
	assert.ok(!block.includes("- page:"), "a Markdown-note capture must not gain a page line");

	const parsed = parseCaptures(block);
	assert.equal(parsed.length, 1);
	assert.ok(!("page" in parsed[0]), "a Markdown-note capture must parse back with no page key, not page: undefined");
	assert.deepEqual(parsed[0], capture);
});

test("a raw-source and a Markdown-note capture appended to one file both parse back correctly", () => {
	const pdfCapture = {
		id: "20260830T000100000-pdf002",
		status: "captured",
		captured: "2026-08-30T00:01:00.000Z",
		source: "sources/clippings/2015.ecarnot-writing-scientific-article.pdf",
		location: "page 1",
		quote: "A passage from a raw source.",
		page: 1,
	};
	const noteCapture = {
		id: "20260830T000200000-note01",
		status: "captured",
		captured: "2026-08-30T00:02:00.000Z",
		source: "wiki/a.md",
		location: "line 1",
		quote: "A passage from a Markdown note.",
	};

	const fileContent = serializeCapture(pdfCapture) + "\n" + serializeCapture(noteCapture);
	const parsed = parseCaptures(fileContent);

	assert.equal(parsed.length, 2);
	assert.deepEqual(parsed[0], pdfCapture);
	assert.deepEqual(parsed[1], noteCapture);
});

test("isRawSourceCapture is true for a source under sources/ and false for a Markdown note", () => {
	assert.equal(isRawSourceCapture({ source: "sources/fphar-08-00438.pdf" }), true);
	assert.equal(isRawSourceCapture({ source: "sources/clippings/x.pdf" }), true);
	assert.equal(isRawSourceCapture({ source: "wiki/concepts/example.md" }), false);
	assert.equal(isRawSourceCapture({ source: "example.md" }), false);
});

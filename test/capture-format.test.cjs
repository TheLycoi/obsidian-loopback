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
const { serializeCapture, parseCaptures, generateCaptureId } = require("../.test-build/capture-format.cjs");

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

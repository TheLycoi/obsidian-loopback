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

test("generateCaptureId produces distinct ids on successive calls", () => {
	const ids = new Set();
	for (let i = 0; i < 50; i++) {
		ids.add(generateCaptureId());
	}
	assert.equal(ids.size, 50);
});

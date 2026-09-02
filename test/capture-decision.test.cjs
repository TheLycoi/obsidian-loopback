/*
Tests for capture-decision.ts, the pure capture-building logic pulled out
of LoopbackPlugin in main.ts. Run via the same esbuild-then-node-test
pipeline as every other pure module, no Obsidian symbol is imported or
stubbed anywhere in this file, unlike the bundle-all-of-main.ts approach
TCK-036 had to fall back on.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCaptureRecord, resolveCaptureLocation, markSelectionAsHighlight } = require("../.test-build/capture-decision.cjs");
const { parseCaptures } = require("../.test-build/capture-format.cjs");

test("resolveCaptureLocation finds the nearest heading at or above the cursor line", () => {
	const lines = ["# Top heading", "some text", "## Sub heading", "more text", "even more"];
	assert.equal(resolveCaptureLocation(lines, 4), "Sub heading");
});

test("resolveCaptureLocation matches a heading on the cursor line itself", () => {
	const lines = ["intro", "## Right here"];
	assert.equal(resolveCaptureLocation(lines, 1), "Right here");
});

test("resolveCaptureLocation falls back to a 1-indexed line number when there is no heading above", () => {
	const lines = ["no heading", "on this file", "at all"];
	assert.equal(resolveCaptureLocation(lines, 2), "line 3");
});

test("resolveCaptureLocation never looks past the cursor line for a heading", () => {
	const lines = ["no heading yet", "still none", "## Heading below, must not be used"];
	assert.equal(resolveCaptureLocation(lines, 1), "line 2");
});

test("buildCaptureRecord fills source, location, and quote from its inputs", () => {
	const now = new Date("2026-08-30T12:00:00.000Z");
	const record = buildCaptureRecord({
		selectionText: "The captured passage.",
		sourcePath: "wiki/concepts/example.md",
		lines: ["# A heading", "the selected line"],
		cursorLine: 1,
		now,
	});

	assert.equal(record.status, "captured");
	assert.equal(record.source, "wiki/concepts/example.md");
	assert.equal(record.location, "A heading");
	assert.equal(record.quote, "The captured passage.");
	assert.equal(record.captured, "2026-08-30T12:00:00.000Z");
});

test("buildCaptureRecord uses the given clock for both id and captured timestamp, deterministically", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");
	const record = buildCaptureRecord({
		selectionText: "text",
		sourcePath: "a.md",
		lines: ["line one"],
		cursorLine: 0,
		now,
	});

	assert.ok(record.id.startsWith("20260101T000000000"));
	assert.equal(record.captured, "2026-01-01T00:00:00.000Z");
});

test("buildCaptureRecord's output round-trips through capture-format.ts unchanged, the format contract this module must never disturb", () => {
	const { serializeCapture } = require("../.test-build/capture-format.cjs");
	const now = new Date("2026-08-30T12:00:00.000Z");
	const record = buildCaptureRecord({
		selectionText: "A multi-line passage.\n\nWith a blank line inside it.",
		sourcePath: "wiki/a.md",
		lines: ["## A heading", "", "selected text"],
		cursorLine: 2,
		now,
	});

	const block = serializeCapture(record);
	const parsed = parseCaptures(block);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], record);
});

/*
TCK-082. Highlighter mode: dragging across a passage marks it and captures
it in one motion. The rule that matters is the reader's own, that a passage
already highlighted must not be marked a second time, because "====text===="
renders as literal equals signs rather than as a highlight.
*/

test("dragging an unmarked passage wraps it in Obsidian's own highlight syntax", () => {
	const marking = markSelectionAsHighlight("the alimentary canal");
	assert.equal(marking.replacement, "==the alimentary canal==");
	assert.equal(marking.quote, "the alimentary canal");
	assert.equal(marking.alreadyMarked, false);
});

test("dragging a passage that is already highlighted leaves the text untouched", () => {
	const marking = markSelectionAsHighlight("==the alimentary canal==");
	assert.equal(marking.replacement, undefined, "no replacement, so the editor is never written to");
	assert.equal(marking.quote, "the alimentary canal", "the card is built from the passage, never from the markers");
	assert.equal(marking.alreadyMarked, true);
});

test("surrounding whitespace from a sloppy drag is trimmed before marking", () => {
	assert.equal(markSelectionAsHighlight("  peritoneum  ").replacement, "==peritoneum==");
});

test("an empty or whitespace-only drag produces nothing to mark and nothing to capture", () => {
	for (const empty of ["", "   ", "\n\t"]) {
		const marking = markSelectionAsHighlight(empty);
		assert.equal(marking.replacement, undefined);
		assert.equal(marking.quote, "");
	}
});

test("a passage that merely contains equals signs is still marked", () => {
	// Not already highlighted: the markers have to be at both ends.
	assert.equal(markSelectionAsHighlight("n == 42 subjects").replacement, "==n == 42 subjects==");
	assert.equal(markSelectionAsHighlight("==unclosed").replacement, "====unclosed==");
});

test("the bare marker alone is too short to count as an existing highlight", () => {
	assert.equal(markSelectionAsHighlight("====").alreadyMarked, false);
});

/*
Tests for the disposition log format in disposition-log.ts: one line per
entry, round-trippable, appended without merging into whatever line came
before it.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatLogLine, parseLogLine, appendLogEntry, appendLogEntries } = require("../.test-build/disposition-log.cjs");

function entry(overrides) {
	return {
		draftId: "draft-a",
		captureId: "capture-a",
		disposition: "approved-clean",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		timestamp: "2026-08-29T00:00:00.000Z",
		...overrides,
	};
}

test("formatLogLine and parseLogLine round-trip an entry", () => {
	const original = entry();
	const parsed = parseLogLine(formatLogLine(original));
	assert.deepEqual(parsed, original);
});

test("parseLogLine round-trips each of the three dispositions", () => {
	for (const disposition of ["approved-clean", "approved-edited", "discarded"]) {
		const original = entry({ disposition });
		assert.deepEqual(parseLogLine(formatLogLine(original)), original);
	}
});

test("parseLogLine returns undefined for a blank line", () => {
	assert.equal(parseLogLine(""), undefined);
	assert.equal(parseLogLine("   "), undefined);
});

test("parseLogLine returns undefined for a line that does not match the format", () => {
	assert.equal(parseLogLine("not a log line at all"), undefined);
});

test("appendLogEntry adds a newline before a new entry when the log does not already end in one", () => {
	const withoutTrailingNewline = formatLogLine(entry({ draftId: "first" })).trim();
	const updated = appendLogEntry(withoutTrailingNewline, entry({ draftId: "second" }));
	const lines = updated.trim().split("\n");

	assert.equal(lines.length, 2);
	assert.equal(parseLogLine(lines[0]).draftId, "first");
	assert.equal(parseLogLine(lines[1]).draftId, "second");
});

test("appendLogEntry on an empty log produces exactly one line", () => {
	const updated = appendLogEntry("", entry());
	assert.equal(updated.trim().split("\n").length, 1);
	assert.deepEqual(parseLogLine(updated.trim()), entry());
});

test("appendLogEntries appends every entry in order", () => {
	const entries = [entry({ draftId: "a" }), entry({ draftId: "b" }), entry({ draftId: "c" })];
	const updated = appendLogEntries("", entries);
	const parsed = updated
		.trim()
		.split("\n")
		.map(parseLogLine);

	assert.deepEqual(
		parsed.map((item) => item.draftId),
		["a", "b", "c"]
	);
});

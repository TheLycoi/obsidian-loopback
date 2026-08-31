/*
Tests for highlight-parsing.ts: the same "JSON array, no fence" contract
draft-parsing.test.cjs would cover for drafts, here for span proposals.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHighlightOutput } = require("../.test-build/highlight-parsing.cjs");

test("parseHighlightOutput reads a well-formed JSON array of spans", () => {
	const text = JSON.stringify([
		{ page: 2, quote: "Short-term memory refers to information processed over a short period of time." },
		{ page: 5, quote: "Long-term memory can last from days to decades." },
	]);
	const spans = parseHighlightOutput(text);
	assert.equal(spans.length, 2);
	assert.equal(spans[0].page, 2);
	assert.match(spans[0].quote, /Short-term memory/);
	assert.equal(spans[1].page, 5);
});

test("parseHighlightOutput strips a markdown code fence around the JSON", () => {
	const text = "```json\n" + JSON.stringify([{ page: 1, quote: "fenced" }]) + "\n```";
	const spans = parseHighlightOutput(text);
	assert.equal(spans.length, 1);
	assert.equal(spans[0].page, 1);
});

test("parseHighlightOutput returns an empty array for an empty JSON array", () => {
	assert.deepEqual(parseHighlightOutput("[]"), []);
});

test("parseHighlightOutput returns an empty array for malformed JSON rather than throwing", () => {
	assert.deepEqual(parseHighlightOutput("not json at all"), []);
});

test("parseHighlightOutput drops an element missing page or quote instead of guessing a default", () => {
	const text = JSON.stringify([
		{ page: 1, quote: "kept" },
		{ page: 2 },
		{ quote: "no page" },
		{ page: "3", quote: "page is a string, not a number" },
	]);
	const spans = parseHighlightOutput(text);
	assert.equal(spans.length, 1);
	assert.equal(spans[0].quote, "kept");
});

test("parseHighlightOutput returns an empty array when the top level is not an array", () => {
	assert.deepEqual(parseHighlightOutput(JSON.stringify({ page: 1, quote: "not an array" })), []);
});

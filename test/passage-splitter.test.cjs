/*
Tests for the pre-call passage splitter in passage-splitter.ts. A passage
under the word ceiling goes to the model whole; one over it is split along
paragraph breaks, and a single paragraph too long on its own is split along
sentence breaks. No model call, no network call.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitPassage, isEmptyPassage, MAX_PASSAGE_WORDS } = require("../.test-build/passage-splitter.cjs");

test("a short passage comes back as a single chunk, unchanged", () => {
	const passage = "Merkel discs are slow-adapting mechanoreceptors.";
	assert.deepEqual(splitPassage(passage), [passage]);
});

test("an empty or whitespace-only passage produces no chunks", () => {
	assert.deepEqual(splitPassage(""), []);
	assert.deepEqual(splitPassage("   \n  "), []);
	assert.equal(isEmptyPassage(""), true);
	assert.equal(isEmptyPassage("   "), true);
	assert.equal(isEmptyPassage("text"), false);
});

test("a passage over the word ceiling splits along paragraph breaks", () => {
	const word = "word";
	const paragraphA = new Array(200).fill(word).join(" ");
	const paragraphB = new Array(200).fill(word).join(" ");
	const passage = `${paragraphA}\n\n${paragraphB}`;

	const chunks = splitPassage(passage, MAX_PASSAGE_WORDS);

	assert.equal(chunks.length, 2);
	assert.equal(chunks[0], paragraphA);
	assert.equal(chunks[1], paragraphB);
});

test("a single paragraph longer than the ceiling splits along sentence breaks", () => {
	const sentence = "This is one sentence about mechanoreceptors and adaptation rates.";
	const longParagraph = new Array(20).fill(sentence).join(" ");

	const chunks = splitPassage(longParagraph, 50);

	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		const wordCount = chunk.trim().split(/\s+/).length;
		assert.ok(wordCount <= 50 + 15, `chunk exceeded the ceiling by more than one sentence: ${wordCount} words`);
	}

	const rejoined = chunks.join(" ").replace(/\s+/g, " ").trim();
	const original = longParagraph.replace(/\s+/g, " ").trim();
	assert.equal(rejoined, original);
});

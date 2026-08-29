/*
Tests for findDraftBlock and replaceDraftBlock in draft-format.ts, the pair
review-actions.ts uses to change exactly one draft's status without
disturbing anything else in the inbox file. The case that matters most is
the middle-of-three case: a replace has to leave the block before and the
block after untouched, byte for byte.

Run via `npm test`, which bundles draft-format.ts to CommonJS with esbuild
first.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeDraft, parseDrafts, findDraftBlock, replaceDraftBlock } = require("../.test-build/draft-format.cjs");

function record(overrides) {
	return {
		id: "20260827T160000000-aaaa11",
		captureId: "20260827T153045123-ab12cd",
		status: "draft",
		cardText: "ADH is released by the {{c1::posterior pituitary}}.",
		backExtra: "The posterior pituitary stores ADH made in the hypothalamus and releases it on demand.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
		...overrides,
	};
}

test("findDraftBlock locates a block by id and parses its record back out", () => {
	const target = record({ id: "target-id" });
	const fileContent = serializeDraft(target);

	const location = findDraftBlock(fileContent, "target-id");

	assert.ok(location);
	assert.deepEqual(location.record, target);
	assert.equal(fileContent.slice(location.start, location.end), fileContent);
});

test("findDraftBlock returns undefined for an id that is not in the file", () => {
	const fileContent = serializeDraft(record({ id: "present-id" }));
	assert.equal(findDraftBlock(fileContent, "absent-id"), undefined);
});

test("replaceDraftBlock changes only the targeted block, leaving the ones before and after untouched", () => {
	const first = record({ id: "first-id", cardText: "First {{c1::card}}." });
	const middle = record({ id: "middle-id", cardText: "Middle {{c1::card}}." });
	const last = record({ id: "last-id", cardText: "Last {{c1::card}}." });
	const fileContent = serializeDraft(first) + serializeDraft(middle) + serializeDraft(last);

	const updatedMiddle = { ...middle, status: "approved" };
	const updated = replaceDraftBlock(fileContent, "middle-id", updatedMiddle);
	const parsed = parseDrafts(updated);

	assert.equal(parsed.length, 3);
	assert.deepEqual(parsed[0], first);
	assert.deepEqual(parsed[1], updatedMiddle);
	assert.deepEqual(parsed[2], last);
});

test("replaceDraftBlock returns the content unchanged when the id does not resolve to a block", () => {
	const fileContent = serializeDraft(record({ id: "present-id" }));
	const result = replaceDraftBlock(fileContent, "absent-id", record({ id: "absent-id", status: "approved" }));
	assert.equal(result, fileContent.replace(/\r\n/g, "\n"));
});

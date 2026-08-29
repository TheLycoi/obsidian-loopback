/*
Tests for the draft block format in draft-format.ts: serializeDraft and
parseDrafts. The case that matters most here is more than one draft block
in the same file, since parseDrafts is what drafting.ts uses to decide
whether a capture already has a draft and should be skipped on the next
pass. A parser that only sees the last block in a file would make every
earlier capture look undrafted forever, and would flood the inbox with
duplicate drafts on every run.

Run via `npm test`, which bundles draft-format.ts to CommonJS with esbuild
first.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeDraft, parseDrafts } = require("../.test-build/draft-format.cjs");

test("a single draft round-trips with identical fields", () => {
	const record = {
		id: "20260827T160000000-aaaa11",
		captureId: "20260827T153045123-ab12cd",
		status: "draft",
		cardText: "ADH is released by the {{c1::posterior pituitary}}.",
		backExtra: "The posterior pituitary stores ADH made in the hypothalamus and releases it on demand.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
	};

	const block = serializeDraft(record);
	const parsed = parseDrafts(block);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], record);
});

test("two draft blocks in one file both parse back, in order, none dropped", () => {
	const first = {
		id: "20260827T160000000-aaaa11",
		captureId: "20260827T153045123-ab12cd",
		status: "draft",
		cardText: "ADH is released by the {{c1::posterior pituitary}} and increases water reabsorption in the {{c2::kidney}}.",
		backExtra: "Reabsorption happens at the collecting duct, where ADH raises the number of water channels in the membrane.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
	};
	const second = {
		id: "20260827T160000001-bbbb22",
		captureId: "20260827T153045123-ab12cd",
		status: "flagged",
		cardText: "{{c1::ADH is released by the posterior pituitary and increases water reabsorption in the kidney}}.",
		backExtra: "ADH is released by the posterior pituitary and increases water reabsorption in the kidney.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: ["cloze-count", "framing-in-braces", "back-extra-substring", "back-extra-near-restatement"],
	};

	const fileContent = serializeDraft(first) + serializeDraft(second);
	const parsed = parseDrafts(fileContent);

	assert.equal(parsed.length, 2);
	assert.deepEqual(parsed[0], first);
	assert.deepEqual(parsed[1], second);
});

test("three draft blocks all parse back, not just the last one", () => {
	const records = [0, 1, 2].map((index) => ({
		id: `20260827T16000000${index}-cccc${index}${index}`,
		captureId: "20260827T153045123-ab12cd",
		status: "draft",
		cardText: `Card number {{c1::${index}}} has one cloze.`,
		backExtra: `This is card ${index}, and the why is that it is a distinct fixture for the test.`,
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
	}));

	const fileContent = records.map(serializeDraft).join("");
	const parsed = parseDrafts(fileContent);

	assert.equal(parsed.length, 3);
	assert.deepEqual(
		parsed.map((draft) => draft.id),
		records.map((draft) => draft.id)
	);
});

test("a flagged draft's lint failures round-trip as a list, not a string", () => {
	const record = {
		id: "20260827T160000000-dddd33",
		captureId: "20260827T153045123-ab12cd",
		status: "flagged",
		cardText: "{{c1::everything}} is inside one cloze.",
		backExtra: "everything is inside one cloze",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: ["cloze-count", "back-extra-substring"],
	};

	const parsed = parseDrafts(serializeDraft(record));

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0].lintFailures, ["cloze-count", "back-extra-substring"]);
});

test("a draft with no lint failures round-trips with an empty array, not the literal string none", () => {
	const record = {
		id: "20260827T160000000-eeee44",
		captureId: "20260827T153045123-ab12cd",
		status: "draft",
		cardText: "Clean cards have {{c1::two}} to {{c2::three}} clozes.",
		backExtra: "The ceiling exists so a card keeps testing one atom instead of drifting into a list.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
	};

	const parsed = parseDrafts(serializeDraft(record));

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0].lintFailures, []);
});

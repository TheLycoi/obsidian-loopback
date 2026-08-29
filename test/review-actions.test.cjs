/*
Tests for the three ways a human decision changes a draft in review-actions.ts:
approve as drafted, edit then approve, and discard, plus their bulk forms.
Every action must produce both the updated file content and a disposition
log entry with the prompt version and model id carried over from the draft
it acted on, since that pairing is the only evidence that would ever
justify tuning the prompt.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeDraft, parseDrafts } = require("../.test-build/draft-format.cjs");
const {
	approveDraft,
	editAndApproveDraft,
	discardDraft,
	bulkApprove,
	bulkDiscard,
} = require("../.test-build/review-actions.cjs");

function record(overrides) {
	return {
		id: "draft-a",
		captureId: "capture-a",
		status: "draft",
		cardText: "The {{c1::posterior pituitary}} releases {{c2::ADH}}.",
		backExtra: "ADH is made in the hypothalamus and released on demand from the posterior pituitary.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
		...overrides,
	};
}

const fixedClock = () => "2026-08-29T00:00:00.000Z";

test("approveDraft sets status to approved and logs approved-clean", () => {
	const fileContent = serializeDraft(record());
	const result = approveDraft(fileContent, "draft-a", fixedClock);

	assert.ok(result);
	assert.equal(parseDrafts(result.fileContent)[0].status, "approved");
	assert.deepEqual(result.logEntry, {
		draftId: "draft-a",
		captureId: "capture-a",
		disposition: "approved-clean",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		timestamp: "2026-08-29T00:00:00.000Z",
	});
});

test("approveDraft returns undefined for an id with no matching draft", () => {
	const fileContent = serializeDraft(record());
	assert.equal(approveDraft(fileContent, "no-such-id", fixedClock), undefined);
});

test("editAndApproveDraft applies the edit, sets status to approved, and logs approved-edited", () => {
	const fileContent = serializeDraft(record());
	const result = editAndApproveDraft(
		fileContent,
		"draft-a",
		{ cardText: "The {{c1::posterior pituitary}} releases {{c2::vasopressin}}." },
		fixedClock
	);

	assert.ok(result);
	const parsed = parseDrafts(result.fileContent)[0];
	assert.equal(parsed.status, "approved");
	assert.equal(parsed.cardText, "The {{c1::posterior pituitary}} releases {{c2::vasopressin}}.");
	assert.equal(parsed.backExtra, record().backExtra, "an edit that only touches cardText leaves backExtra as drafted");
	assert.equal(result.logEntry.disposition, "approved-edited");
});

test("editAndApproveDraft can change backExtra alone, leaving cardText as drafted", () => {
	const fileContent = serializeDraft(record());
	const result = editAndApproveDraft(fileContent, "draft-a", { backExtra: "A clearer why." }, fixedClock);

	const parsed = parseDrafts(result.fileContent)[0];
	assert.equal(parsed.cardText, record().cardText);
	assert.equal(parsed.backExtra, "A clearer why.");
});

test("discardDraft sets status to discarded, keeps the card text, and logs discarded", () => {
	const fileContent = serializeDraft(record());
	const result = discardDraft(fileContent, "draft-a", fixedClock);

	assert.ok(result);
	const parsed = parseDrafts(result.fileContent)[0];
	assert.equal(parsed.status, "discarded");
	assert.equal(parsed.cardText, record().cardText);
	assert.equal(result.logEntry.disposition, "discarded");
});

test("bulkApprove approves every id and reports one that does not resolve", () => {
	const fileContent = serializeDraft(record({ id: "draft-a" })) + serializeDraft(record({ id: "draft-b", captureId: "capture-b" }));
	const result = bulkApprove(fileContent, ["draft-a", "draft-b", "missing-id"], fixedClock);

	const parsed = parseDrafts(result.fileContent);
	assert.deepEqual(
		parsed.map((draft) => draft.status),
		["approved", "approved"]
	);
	assert.equal(result.logEntries.length, 2);
	assert.deepEqual(result.missingIds, ["missing-id"]);
});

test("bulkDiscard discards every id and reports one that does not resolve", () => {
	const fileContent = serializeDraft(record({ id: "draft-a" })) + serializeDraft(record({ id: "draft-b", captureId: "capture-b" }));
	const result = bulkDiscard(fileContent, ["draft-a", "missing-id"], fixedClock);

	const parsed = parseDrafts(result.fileContent);
	assert.equal(parsed.find((draft) => draft.id === "draft-a").status, "discarded");
	assert.equal(parsed.find((draft) => draft.id === "draft-b").status, "draft");
	assert.deepEqual(result.missingIds, ["missing-id"]);
});

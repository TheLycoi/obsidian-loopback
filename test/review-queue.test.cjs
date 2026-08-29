/*
Tests for buildQueue and shouldRefuseCapture in review-queue.ts: grouping
drafts by the capture (the source passage) they came from, splitting stale
groups (older than 30 days) from fresh ones, and the 50-pending-draft
ceiling decision 5 sets for refusing a new capture outright.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { serializeCapture } = require("../.test-build/capture-format.cjs");
const { serializeDraft } = require("../.test-build/draft-format.cjs");
const { buildQueue, shouldRefuseCapture, MAX_PENDING_DRAFTS, STALE_DAYS } = require("../.test-build/review-queue.cjs");

const NOW = new Date("2026-08-29T00:00:00.000Z");

function capture(overrides) {
	return {
		id: "capture-a",
		status: "captured",
		captured: "2026-08-28T00:00:00.000Z",
		source: "wiki/concepts/example.md",
		location: "Definition",
		quote: "The example passage.",
		...overrides,
	};
}

function draft(overrides) {
	return {
		id: "draft-a",
		captureId: "capture-a",
		status: "draft",
		cardText: "This is {{c1::an}} {{c2::example}}.",
		backExtra: "Because it demonstrates the fixture shape.",
		promptVersion: "draft-v1",
		modelId: "fake-model-1",
		lintFailures: [],
		...overrides,
	};
}

test("a pending draft groups with the capture it came from", () => {
	const fileContent = serializeCapture(capture()) + serializeDraft(draft());
	const queue = buildQueue(fileContent, NOW);

	assert.equal(queue.pendingCount, 1);
	assert.equal(queue.freshGroups.length, 1);
	assert.equal(queue.staleGroups.length, 0);
	assert.equal(queue.freshGroups[0].capture.id, "capture-a");
	assert.equal(queue.freshGroups[0].drafts.length, 1);
});

test("a group whose capture is older than 30 days lands in staleGroups, not freshGroups", () => {
	const oldCapture = capture({ id: "capture-old", captured: "2026-07-01T00:00:00.000Z" });
	const fileContent = serializeCapture(oldCapture) + serializeDraft(draft({ captureId: "capture-old" }));
	const queue = buildQueue(fileContent, NOW);

	assert.equal(queue.staleGroups.length, 1);
	assert.equal(queue.freshGroups.length, 0);
	assert.equal(queue.staleGroups[0].stale, true);
	assert.ok(NOW.getTime() - new Date(oldCapture.captured).getTime() > STALE_DAYS * 24 * 60 * 60 * 1000);
});

test("a draft already approved, exported, or discarded does not count as pending and forms no group", () => {
	const fileContent =
		serializeCapture(capture()) +
		serializeDraft(draft({ id: "draft-approved", status: "approved" })) +
		serializeDraft(draft({ id: "draft-exported", status: "exported" })) +
		serializeDraft(draft({ id: "draft-discarded", status: "discarded" }));
	const queue = buildQueue(fileContent, NOW);

	assert.equal(queue.pendingCount, 0);
	assert.equal(queue.freshGroups.length, 0);
	assert.equal(queue.staleGroups.length, 0);
});

test("a draft whose captureId matches no capture becomes an orphan, not a silent drop", () => {
	const fileContent = serializeDraft(draft({ captureId: "no-such-capture" }));
	const queue = buildQueue(fileContent, NOW);

	assert.equal(queue.pendingCount, 1);
	assert.equal(queue.orphanDrafts.length, 1);
	assert.equal(queue.orphanDrafts[0].id, "draft-a");
});

test("shouldRefuseCapture is false at exactly 50 pending drafts", () => {
	const drafts = Array.from({ length: MAX_PENDING_DRAFTS }, (_, index) =>
		serializeDraft(draft({ id: `draft-${index}`, captureId: "orphan-capture" }))
	).join("");
	assert.equal(shouldRefuseCapture(drafts, NOW), false);
});

test("shouldRefuseCapture is true once pending drafts exceed 50", () => {
	const drafts = Array.from({ length: MAX_PENDING_DRAFTS + 1 }, (_, index) =>
		serializeDraft(draft({ id: `draft-${index}`, captureId: "orphan-capture" }))
	).join("");
	assert.equal(shouldRefuseCapture(drafts, NOW), true);
});

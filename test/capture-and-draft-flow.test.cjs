/*
Tests for runCaptureAndDraft in capture-and-draft-flow.ts: the ordering the
whole ticket turns on. Capture must be written before the sidebar opens and
before drafting starts, so an interrupted or failed draft can never lose
the passage. These fakes never touch the Obsidian API, the vault, or a
network call, exactly like capture-decision.test.cjs, so the ordering claim
is proven on its own rather than trusted because main.ts happens to call
things in the right sequence.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { runCaptureAndDraft } = require("../.test-build/capture-and-draft-flow.cjs");

test("capture, then reveal, then draft run strictly in that order", async () => {
	const calls = [];
	await runCaptureAndDraft({
		capture: async () => {
			calls.push("capture");
		},
		reveal: async () => {
			calls.push("reveal");
		},
		draft: async () => {
			calls.push("draft");
		},
	});
	assert.deepEqual(calls, ["capture", "reveal", "draft"]);
});

test("the capture write is fully finished, not merely started, before reveal is invoked", async () => {
	const calls = [];
	let captureResolved = false;
	await runCaptureAndDraft({
		capture: async () => {
			calls.push("capture-start");
			await new Promise((resolve) => setTimeout(resolve, 10));
			captureResolved = true;
			calls.push("capture-end");
		},
		reveal: async () => {
			// If runCaptureAndDraft only started capture without awaiting it,
			// this would run before capture-end above.
			assert.equal(captureResolved, true);
			calls.push("reveal");
		},
		draft: async () => {
			calls.push("draft");
		},
	});
	assert.deepEqual(calls, ["capture-start", "capture-end", "reveal", "draft"]);
});

test("reveal fully finishes before draft is invoked", async () => {
	const calls = [];
	let revealResolved = false;
	await runCaptureAndDraft({
		capture: async () => {
			calls.push("capture");
		},
		reveal: async () => {
			calls.push("reveal-start");
			await new Promise((resolve) => setTimeout(resolve, 10));
			revealResolved = true;
			calls.push("reveal-end");
		},
		draft: async () => {
			assert.equal(revealResolved, true);
			calls.push("draft");
		},
	});
	assert.deepEqual(calls, ["capture", "reveal-start", "reveal-end", "draft"]);
});

test("a capture failure stops the sequence: reveal and draft never run", async () => {
	const calls = [];
	await assert.rejects(
		runCaptureAndDraft({
			capture: async () => {
				calls.push("capture");
				throw new Error("disk write failed");
			},
			reveal: async () => {
				calls.push("reveal");
			},
			draft: async () => {
				calls.push("draft");
			},
		}),
		/disk write failed/
	);
	assert.deepEqual(calls, ["capture"]);
});

test("a reveal failure stops the sequence before draft: drafting never starts for a sidebar that failed to open", async () => {
	const calls = [];
	await assert.rejects(
		runCaptureAndDraft({
			capture: async () => {
				calls.push("capture");
			},
			reveal: async () => {
				calls.push("reveal");
				throw new Error("could not open leaf");
			},
			draft: async () => {
				calls.push("draft");
			},
		}),
		/could not open leaf/
	);
	assert.deepEqual(calls, ["capture", "reveal"]);
});

test("drafting stays off the capture path: runCaptureAndDraft resolves without waiting for draft to finish", async () => {
	const calls = [];
	let draftResolved = false;
	let releaseDraft;
	const draftGate = new Promise((resolve) => {
		releaseDraft = resolve;
	});

	const done = runCaptureAndDraft({
		capture: async () => {
			calls.push("capture");
		},
		reveal: async () => {
			calls.push("reveal");
		},
		draft: async () => {
			calls.push("draft-start");
			await draftGate;
			draftResolved = true;
			calls.push("draft-end");
		},
	});

	// runCaptureAndDraft must settle even though draft has not, proving
	// drafting never adds latency to what the reviewer already saw complete
	// (capture written, sidebar revealed).
	await done;
	assert.equal(draftResolved, false);
	assert.deepEqual(calls, ["capture", "reveal", "draft-start"]);

	releaseDraft();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(draftResolved, true);
});

test("capture makes no network call: the fake used here is plain in-memory bookkeeping, nothing async-IO-shaped beyond a resolved promise", async () => {
	// This is a structural check, not a runtime one: runCaptureAndDraft's own
	// module (capture-and-draft-flow.ts) imports nothing beyond its own type
	// declarations, so it cannot itself introduce a network call regardless
	// of what real steps main.ts wires in. The capture step's real
	// implementation (LoopbackPlugin.appendToInbox, via prepareCapture and
	// buildCaptureRecord) is vault I/O only, unchanged by this ticket, and is
	// covered separately by capture-decision.test.cjs and
	// capture-format.test.cjs.
	const source = require("node:fs").readFileSync(require.resolve("../capture-and-draft-flow.ts"), "utf8");
	assert.equal(/https?:\/\//.test(source), false);
	assert.equal(/fetch\(/.test(source), false);
});

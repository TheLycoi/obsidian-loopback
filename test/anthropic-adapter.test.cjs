/*
Tests for adapters/anthropic.ts. Every test injects a fake fetch and a fake
readEnv, the same pattern anki-client.test.cjs and keys.test.cjs already
use, so nothing here makes a real network call or a real Anthropic call.
No fixture in this file is a real API key.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { AnthropicAdapter } = require("../.test-build/anthropic-adapter.cjs");

const FAKE_KEY = "sk-ant-fake-placeholder-not-a-real-key-0000000000";

function adapter(fetchImpl) {
	return new AnthropicAdapter({
		modelId: "claude-fake-model",
		apiKeySource: "env",
		envVarName: "FAKE_ANTHROPIC_KEY",
		fetchImpl,
		readEnv: () => FAKE_KEY,
		readKeychain: () => undefined,
	});
}

function failingFetch(status, bodyText) {
	return async () => ({ ok: false, status, text: async () => bodyText });
}

test("a failed call reports the HTTP status and the provider's own message", async () => {
	const usageCapBody = JSON.stringify({
		error: { message: "You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC." },
	});

	let thrown;
	try {
		await adapter(failingFetch(400, usageCapBody)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(thrown.message.includes("400"));
	assert.ok(thrown.message.includes("You have reached your specified API usage limits"));
});

test("a usage-cap 400 and a bad-model-id 400 read differently", async () => {
	const usageCapBody = JSON.stringify({
		error: { message: "You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC." },
	});
	const badModelBody = JSON.stringify({ error: { message: "model: claude-fake-model is not a valid model ID" } });

	let usageCapError;
	try {
		await adapter(failingFetch(400, usageCapBody)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		usageCapError = error;
	}

	let badModelError;
	try {
		await adapter(failingFetch(400, badModelBody)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		badModelError = error;
	}

	assert.ok(usageCapError);
	assert.ok(badModelError);
	assert.notEqual(usageCapError.message, badModelError.message);
	assert.ok(usageCapError.message.includes("2026-09-01"));
	assert.ok(badModelError.message.includes("claude-fake-model"));
});

test("the resolved API key does not survive into a thrown error, even when the body echoes it", async () => {
	const body = JSON.stringify({ error: { message: `Invalid request body, offending value: ${FAKE_KEY}` } });

	let thrown;
	try {
		await adapter(failingFetch(400, body)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(!thrown.message.includes(FAKE_KEY), "the API key must not appear in the thrown message");
	assert.ok(!/[A-Za-z0-9_-]{20,}/.test(thrown.message), "no key-shaped run should survive into the thrown message");
});

test("the status code is still reachable on the thrown error", async () => {
	let thrown;
	try {
		await adapter(failingFetch(429, JSON.stringify({ error: { message: "slow down" } }))).draft(
			"a passage",
			{ source: "a.md", location: "line 1" },
			"draft-v1"
		);
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown);
	assert.equal(thrown.status, 429);
});

test("a successful call still parses drafts out of the response, unaffected by the error-path change", async () => {
	const modelText = JSON.stringify([{ cardText: "{{c1::Fact}} is {{c2::true}}.", backExtra: "Because the passage says so." }]);
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ content: [{ text: modelText }] }),
	});

	const drafts = await adapter(fetchImpl).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");

	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].modelId, "claude-fake-model");
	assert.equal(drafts[0].promptVersion, "draft-v1");
});

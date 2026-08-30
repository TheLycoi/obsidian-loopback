/*
Tests for adapters/openai-compatible.ts. Every test injects a fake fetch and
a fake readEnv, the same pattern anthropic-adapter.test.cjs and
anki-client.test.cjs already use, so nothing here makes a real network call.
No fixture in this file is a real API key.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { OpenAiCompatibleAdapter } = require("../.test-build/openai-compatible-adapter.cjs");

const FAKE_KEY = "sk-fake-openrouter-placeholder-not-a-real-key-0000";

function adapter(fetchImpl) {
	return new OpenAiCompatibleAdapter({
		modelId: "fake-model",
		baseUrl: "https://example.invalid/api/v1",
		apiKeySource: "env",
		envVarName: "FAKE_OPENAI_KEY",
		fetchImpl,
		readEnv: () => FAKE_KEY,
		readKeychain: () => undefined,
	});
}

function failingFetch(status, bodyText) {
	return async () => ({ ok: false, status, text: async () => bodyText });
}

test("a failed call reports the HTTP status and the provider's own message", async () => {
	const body = JSON.stringify({ error: { message: "Rate limit exceeded, retry after 30 seconds." } });

	let thrown;
	try {
		await adapter(failingFetch(429, body)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(thrown.message.includes("429"));
	assert.ok(thrown.message.includes("Rate limit exceeded, retry after 30 seconds."));
});

test("a usage-cap 400 and a bad-model-id 400 read differently", async () => {
	const usageCapBody = JSON.stringify({ error: { message: "Monthly usage cap reached. Resets 2026-09-01." } });
	const badModelBody = JSON.stringify({ error: { message: "The model 'fake-model' does not exist." } });

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

	assert.notEqual(usageCapError.message, badModelError.message);
	assert.ok(usageCapError.message.includes("2026-09-01"));
	assert.ok(badModelError.message.includes("fake-model"));
});

test("the resolved API key does not survive into a thrown error, even when the body echoes it", async () => {
	const body = JSON.stringify({ error: { message: `Unauthorized, key received: ${FAKE_KEY}` } });

	let thrown;
	try {
		await adapter(failingFetch(401, body)).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(!thrown.message.includes(FAKE_KEY));
	assert.ok(!/[A-Za-z0-9_-]{20,}/.test(thrown.message));
});

test("a successful call still parses drafts out of the response, unaffected by the error-path change", async () => {
	const modelText = JSON.stringify([{ cardText: "{{c1::Fact}} is {{c2::true}}.", backExtra: "Because the passage says so." }]);
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: modelText } }] }),
	});

	const drafts = await adapter(fetchImpl).draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");

	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].modelId, "fake-model");
});

test("the chat completions endpoint is built from baseUrl regardless of a trailing slash", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
	};
	const withTrailingSlash = new OpenAiCompatibleAdapter({
		modelId: "fake-model",
		baseUrl: "https://example.invalid/api/v1/",
		apiKeySource: "env",
		envVarName: "FAKE_OPENAI_KEY",
		fetchImpl,
		readEnv: () => FAKE_KEY,
		readKeychain: () => undefined,
	});

	await withTrailingSlash.draft("a passage", { source: "a.md", location: "line 1" }, "draft-v1");

	assert.equal(calls[0], "https://example.invalid/api/v1/chat/completions");
});

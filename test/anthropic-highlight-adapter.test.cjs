/*
Tests for adapters/anthropic-highlight.ts. Every test injects a fake fetch
and a fake readEnv, the same pattern anthropic-adapter.test.cjs uses, so
nothing here makes a real network call or a real Anthropic call. No fixture
in this file is a real API key.

No test in this file, or anywhere in this repository, proves a live
Anthropic call actually proposes usable spans from a real PDF: the account
this project runs under is capped until 2026-09-01. That proof is
outstanding; see the Worker Log for TCK-073.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { AnthropicHighlightAdapter } = require("../.test-build/anthropic-highlight-adapter.cjs");

const FAKE_KEY = "sk-ant-fake-placeholder-not-a-real-key-0000000000";

function adapter(fetchImpl) {
	return new AnthropicHighlightAdapter({
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

const PAGES = [
	{ number: 1, text: "Page one text." },
	{ number: 2, text: "Page two has the definition worth capturing." },
];

test("a successful call parses spans out of the response", async () => {
	const modelText = JSON.stringify([{ page: 2, quote: "the definition worth capturing" }]);
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		assert.equal(body.model, "claude-fake-model");
		assert.ok(body.messages[0].content.includes("--- page 1 ---"));
		assert.ok(body.messages[0].content.includes("--- page 2 ---"));
		return { ok: true, status: 200, json: async () => ({ content: [{ text: modelText }] }) };
	};

	const spans = await adapter(fetchImpl).proposeSpans(PAGES);
	assert.equal(spans.length, 1);
	assert.equal(spans[0].page, 2);
});

test("an optional prompt is appended as additional guidance in the request", async () => {
	let sentContent;
	const fetchImpl = async (url, init) => {
		sentContent = JSON.parse(init.body).messages[0].content;
		return { ok: true, status: 200, json: async () => ({ content: [{ text: "[]" }] }) };
	};

	await adapter(fetchImpl).proposeSpans(PAGES, "find the definitions");
	assert.ok(sentContent.includes("Additional guidance: find the definitions"));
});

test("a failed call reports the HTTP status and the provider's own message, labeled as a highlight call", async () => {
	const body = JSON.stringify({ error: { message: "You have reached your specified API usage limits." } });

	let thrown;
	try {
		await adapter(failingFetch(400, body)).proposeSpans(PAGES);
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(thrown.message.includes("highlight call failed"));
	assert.ok(thrown.message.includes("400"));
	assert.ok(thrown.message.includes("You have reached your specified API usage limits"));
});

test("the resolved API key does not survive into a thrown error, even when the body echoes it", async () => {
	const body = JSON.stringify({ error: { message: `Invalid request, offending value: ${FAKE_KEY}` } });

	let thrown;
	try {
		await adapter(failingFetch(400, body)).proposeSpans(PAGES);
	} catch (error) {
		thrown = error;
	}

	assert.ok(thrown);
	assert.ok(!thrown.message.includes(FAKE_KEY));
	assert.ok(!/[A-Za-z0-9_-]{20,}/.test(thrown.message));
});

test("proposeSpans makes no network call itself beyond the one fetch it issues; a malformed model response yields an empty array, not a throw", async () => {
	const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: "not json" }] }) });
	const spans = await adapter(fetchImpl).proposeSpans(PAGES);
	assert.deepEqual(spans, []);
});

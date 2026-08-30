/*
Tests for adapters/adapter-error.ts. No fixture in this file is a real API
key: every key-shaped value below is an obviously fake placeholder.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { DraftingAdapterError, redactKeyMaterial, extractProviderMessage } = require("../.test-build/adapter-error.cjs");

test("extractProviderMessage reads Anthropic's nested error.message shape", () => {
	const body = JSON.stringify({
		type: "error",
		error: { type: "rate_limit_error", message: "You have reached your specified API usage limits." },
	});
	assert.equal(extractProviderMessage(body), "You have reached your specified API usage limits.");
});

test("extractProviderMessage reads an OpenAI-compatible error.message shape", () => {
	const body = JSON.stringify({ error: { message: "model: not-a-real-model is not a valid model ID", type: "invalid_request_error" } });
	assert.equal(extractProviderMessage(body), "model: not-a-real-model is not a valid model ID");
});

test("extractProviderMessage reads a bare string at error, for a server that skips the nested object", () => {
	const body = JSON.stringify({ error: "bad request" });
	assert.equal(extractProviderMessage(body), "bad request");
});

test("extractProviderMessage falls back to the raw body when it is not JSON", () => {
	assert.equal(extractProviderMessage("  upstream timed out  "), "upstream timed out");
});

test("extractProviderMessage names an empty body rather than returning an empty string", () => {
	assert.equal(extractProviderMessage(""), "(empty response body)");
});

test("a usage-cap 400 and a bad-model-id 400 produce visibly different messages", () => {
	const usageCap = new DraftingAdapterError(
		"Anthropic",
		400,
		JSON.stringify({
			error: {
				message: "You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.",
			},
		})
	);
	const badModel = new DraftingAdapterError(
		"Anthropic",
		400,
		JSON.stringify({ error: { message: "model: claude-not-real is not a valid model ID" } })
	);

	assert.notEqual(usageCap.message, badModel.message);
	assert.ok(usageCap.message.includes("2026-09-01"));
	assert.ok(badModel.message.includes("claude-not-real"));
	assert.ok(usageCap.message.includes("status 400"));
	assert.ok(badModel.message.includes("status 400"));
});

test("redactKeyMaterial strips a key-shaped string out of an error body's message", () => {
	const keyShaped = "sk-ant-api03-" + "x7y8z9placeholderNOTREALaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const body = JSON.stringify({ error: { message: `Invalid request, the key ${keyShaped} was rejected.` } });

	const error = new DraftingAdapterError("Anthropic", 401, body);

	assert.ok(!error.message.includes(keyShaped), "the key-shaped string must not survive into the message");
	assert.ok(!/[A-Za-z0-9_-]{20,}/.test(error.message), "no run of 20+ key-alphabet characters should survive");
	assert.ok(error.message.includes("Invalid request"), "the surrounding provider text should still be readable");
});

test("DraftingAdapterError redacts the exact resolved API key, even one short of the key-shaped pattern's length", () => {
	const shortKey = "abc123shortkey";
	const body = JSON.stringify({ error: { message: `Rejected key: ${shortKey}` } });

	const error = new DraftingAdapterError("OpenAI-compatible", 401, body, [shortKey]);

	assert.ok(!error.message.includes(shortKey));
	assert.ok(error.message.includes("[redacted]"));
});

test("DraftingAdapterError carries the HTTP status separately from the message", () => {
	const error = new DraftingAdapterError("Anthropic", 429, JSON.stringify({ error: { message: "slow down" } }));
	assert.equal(error.status, 429);
	assert.equal(error.name, "DraftingAdapterError");
});

test("redactKeyMaterial leaves ordinary prose, including dates, untouched", () => {
	const text = "You will regain access on 2026-09-01 at 00:00 UTC.";
	assert.equal(redactKeyMaterial(text), text);
});

/*
Tests for key resolution in keys.ts. Every test injects readEnv and
readKeychain rather than touching a real environment variable or a real
keychain entry, and no fixture in this file is a real API key: every value
below is an obviously fake placeholder string.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveApiKey, MissingApiKeyError } = require("../.test-build/keys.cjs");

test("an environment variable is used when present, before the keychain is even checked", () => {
	let keychainWasCalled = false;
	const key = resolveApiKey({
		apiKeySource: "env",
		envVarName: "FAKE_ENV_VAR",
		serviceLabel: "test-service",
		readEnv: () => "env-placeholder-not-a-real-key",
		readKeychain: () => {
			keychainWasCalled = true;
			return "keychain-placeholder-not-a-real-key";
		},
	});

	assert.equal(key, "env-placeholder-not-a-real-key");
	assert.equal(keychainWasCalled, false);
});

test("the keychain is used when the environment variable is absent", () => {
	const key = resolveApiKey({
		apiKeySource: "keychain",
		envVarName: "FAKE_ENV_VAR",
		serviceLabel: "test-service",
		readEnv: () => undefined,
		readKeychain: () => "keychain-placeholder-not-a-real-key",
	});

	assert.equal(key, "keychain-placeholder-not-a-real-key");
});

test("the in-vault key is used only when apiKeySource is vault, even if a vault key is supplied", () => {
	assert.throws(
		() =>
			resolveApiKey({
				apiKeySource: "env",
				envVarName: "FAKE_ENV_VAR",
				serviceLabel: "test-service",
				vaultKey: "vault-placeholder-not-a-real-key",
				readEnv: () => undefined,
				readKeychain: () => undefined,
			}),
		MissingApiKeyError
	);

	const key = resolveApiKey({
		apiKeySource: "vault",
		envVarName: "FAKE_ENV_VAR",
		serviceLabel: "test-service",
		vaultKey: "vault-placeholder-not-a-real-key",
		readEnv: () => undefined,
		readKeychain: () => undefined,
	});
	assert.equal(key, "vault-placeholder-not-a-real-key");
});

test("no source having a key throws MissingApiKeyError naming the service, never a key value", () => {
	try {
		resolveApiKey({
			apiKeySource: "vault",
			envVarName: "FAKE_ENV_VAR",
			serviceLabel: "test-service-label",
			readEnv: () => undefined,
			readKeychain: () => undefined,
		});
		assert.fail("expected resolveApiKey to throw");
	} catch (error) {
		assert.ok(error instanceof MissingApiKeyError);
		assert.ok(error.message.includes("test-service-label"));
		assert.ok(!/[A-Za-z0-9_-]{20,}/.test(error.message), "error message should not contain anything key-shaped");
	}
});

test("resolveApiKey never throws a message containing an injected key value", () => {
	try {
		resolveApiKey({
			apiKeySource: "env",
			envVarName: "FAKE_ENV_VAR",
			serviceLabel: "test-service",
			readEnv: () => undefined,
			readKeychain: () => undefined,
		});
	} catch (error) {
		assert.ok(!error.message.includes("placeholder-not-a-real-key"));
	}
});

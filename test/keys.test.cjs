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

/*
TCK-080 follow-on. A key stored in the keychain under the environment
variable's name, which is the convention nearly everyone follows, was
invisible to Loopback: only the plugin's own descriptive service label was
ever queried. The symptom was "No API key found" while the key sat in the
keychain the whole time.
*/

test("a key stored under the environment variable name is found in the keychain", () => {
	const asked = [];
	const key = resolveApiKey({
		apiKeySource: "env",
		envVarName: "ANTHROPIC_API_KEY",
		serviceLabel: "Loopback Anthropic API key",
		readEnv: () => undefined,
		readKeychain: (name) => {
			asked.push(name);
			return name === "ANTHROPIC_API_KEY" ? "sk-test-from-keychain" : undefined;
		},
	});
	assert.equal(key, "sk-test-from-keychain");
	assert.deepEqual(asked, ["Loopback Anthropic API key", "ANTHROPIC_API_KEY"]);
});

test("the plugin's own service label still wins when both exist", () => {
	const key = resolveApiKey({
		apiKeySource: "env",
		envVarName: "ANTHROPIC_API_KEY",
		serviceLabel: "Loopback Anthropic API key",
		readEnv: () => undefined,
		readKeychain: (name) => (name === "Loopback Anthropic API key" ? "sk-specific" : "sk-generic"),
	});
	assert.equal(key, "sk-specific");
});

test("the environment variable still beats both keychain names", () => {
	const key = resolveApiKey({
		apiKeySource: "env",
		envVarName: "ANTHROPIC_API_KEY",
		serviceLabel: "Loopback Anthropic API key",
		readEnv: () => "sk-from-env",
		readKeychain: () => "sk-from-keychain",
	});
	assert.equal(key, "sk-from-env");
});

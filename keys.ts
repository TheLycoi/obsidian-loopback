/*
Key resolution for the drafting adapters, in the order decision 3 of the
design note sets: environment variable first, OS keychain second, and an
in-vault setting last, read only when the owner has explicitly chosen it in
Settings. Environment and keychain are checked regardless of which source
is selected, since both are strictly safer than a value synced through
iCloud in plaintext; the settings choice only gates whether the vault
fallback is allowed to fire at all.

A key is never logged, never written to the inbox file, and never included
in an error message. Errors here name the service being looked up, not the
value found or missing.
*/

import { execFileSync } from "child_process";

export type ApiKeySource = "env" | "keychain" | "vault";

export interface KeyResolutionRequest {
	/** Which source the owner picked in Settings. */
	apiKeySource: ApiKeySource;
	/** The environment variable to check first, for example "ANTHROPIC_API_KEY". */
	envVarName: string;
	/** A label for the keychain entry and for error messages. Never a key value. */
	serviceLabel: string;
	/** The vault-stored key, read only when apiKeySource is "vault". */
	vaultKey?: string;
	/** Injectable for tests, so a test never has to set a real environment variable. */
	readEnv?: (name: string) => string | undefined;
	/** Injectable for tests, so a test never has to touch a real keychain. */
	readKeychain?: (serviceLabel: string) => string | undefined;
}

export class MissingApiKeyError extends Error {
	constructor(serviceLabel: string) {
		super(
			`No API key found for ${serviceLabel}. Checked the environment variable, the OS keychain, and the in-vault setting (the last one only when API key source in Settings is set to vault).`
		);
		this.name = "MissingApiKeyError";
	}
}

function defaultReadEnv(name: string): string | undefined {
	return typeof process !== "undefined" ? process.env[name] : undefined;
}

/**
 * Read a generic password from the macOS keychain. Returns undefined on any
 * failure, including "not found," and never surfaces stderr content, which
 * is where a wrong-account message could otherwise leak into a log.
 */
function defaultReadKeychain(serviceLabel: string): string | undefined {
	if (typeof process === "undefined" || process.platform !== "darwin") {
		return undefined;
	}
	try {
		const result = execFileSync("security", ["find-generic-password", "-s", serviceLabel, "-w"], {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		});
		const trimmed = result.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve an API key without ever surfacing its value in a log or an error.
 * Throws MissingApiKeyError, which names the service and never the key,
 * when no source has one.
 */
export function resolveApiKey(request: KeyResolutionRequest): string {
	const readEnv = request.readEnv ?? defaultReadEnv;
	const fromEnv = readEnv(request.envVarName);
	if (fromEnv) return fromEnv;

	// Two keychain names are tried, in this order, and the second one is the
	// one that actually matches how people store keys. serviceLabel is
	// Loopback's own descriptive name ("Loopback Anthropic API key"), which
	// only finds a key someone created specifically for this plugin.
	// envVarName ("ANTHROPIC_API_KEY") is the convention almost everyone
	// already follows, and a key stored that way was previously invisible to
	// Loopback even though it was sitting right there, which read as "no API
	// key found" when one existed.
	const readKeychain = request.readKeychain ?? defaultReadKeychain;
	for (const name of [request.serviceLabel, request.envVarName]) {
		const fromKeychain = readKeychain(name);
		if (fromKeychain) return fromKeychain;
	}

	if (request.apiKeySource === "vault" && request.vaultKey) {
		return request.vaultKey;
	}

	throw new MissingApiKeyError(request.serviceLabel);
}

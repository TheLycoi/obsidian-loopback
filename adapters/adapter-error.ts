/*
Shared error handling for the drafting adapters. Both Anthropic and the
OpenAI-compatible backend hit the same problem on a failed call: the
provider's own response body usually explains exactly why, a bad model id,
a malformed request, or a usage cap, and throwing that text away left a
reviewer with nothing but "status 400," a message identical whether the
cause was a wrong model id or an account cap with a specific reset date in
it (TCK-036 hit the latter and had to leave the plugin to find out).

The response body is also the one place request content can be echoed
back, so a resolved API key could ride along inside it. This module keeps
the provider's message and redacts anything key-shaped out of it, rather
than discarding the whole body to be safe.
*/

/**
 * Any run of 20 or more characters drawn from the alphabet a key is built
 * from, with no separator. keys.test.cjs already checks resolveApiKey's own
 * error messages against this same threshold; every real API key format in
 * use here, Anthropic's, OpenAI's, and OpenRouter's, comfortably clears it.
 */
const KEY_SHAPED_PATTERN = /[A-Za-z0-9_-]{20,}/g;
const REDACTED = "[redacted]";

/**
 * Replace every key-shaped run in text with a redaction marker. Also takes
 * an exact-match pass first, for a secret the caller knows was used in the
 * request, the resolved API key, which covers a key too short to be caught
 * by the pattern alone. Guarantees redaction rather than relying on the
 * pattern matching every possible key format a provider might introduce.
 */
export function redactKeyMaterial(text: string, knownSecrets: readonly string[] = []): string {
	let result = text;
	for (const secret of knownSecrets) {
		if (secret.length === 0) continue;
		result = result.split(secret).join(REDACTED);
	}
	return result.replace(KEY_SHAPED_PATTERN, REDACTED);
}

/**
 * Pull the human-readable message out of a provider's error body. Anthropic
 * and OpenAI-compatible backends both nest it at "error.message"; a few
 * OpenAI-compatible servers put a bare string at "error" instead. Falls
 * back to the raw body, trimmed, when it is not JSON or carries none of
 * those shapes, so a provider that changes its error schema still
 * surfaces something rather than nothing.
 */
export function extractProviderMessage(bodyText: string): string {
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return "(empty response body)";

	try {
		const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string };
		if (typeof parsed.error === "string" && parsed.error.length > 0) {
			return parsed.error;
		}
		if (
			parsed.error &&
			typeof parsed.error === "object" &&
			typeof parsed.error.message === "string" &&
			parsed.error.message.length > 0
		) {
			return parsed.error.message;
		}
		if (typeof parsed.message === "string" && parsed.message.length > 0) {
			return parsed.message;
		}
	} catch {
		// Not JSON. Fall through to the raw body below.
	}

	return trimmed;
}

/**
 * A failed drafting or highlight call, carrying the HTTP status and the
 * provider's own message, redacted of anything key-shaped. A usage-cap 400
 * and a bad-model-id 400 now read differently, because the provider's own
 * words survive into this message instead of being thrown away in favor of
 * the status code alone.
 */
export class DraftingAdapterError extends Error {
	readonly status: number;

	/**
	 * action names what the call was trying to do, "drafting" by default.
	 * AnthropicHighlightAdapter passes "highlight" so a rejected automatic
	 * highlight call reads as what it is rather than borrowing drafting's
	 * wording for an unrelated call.
	 */
	constructor(
		providerLabel: string,
		status: number,
		bodyText: string,
		knownSecrets: readonly string[] = [],
		action: string = "drafting"
	) {
		const rawMessage = extractProviderMessage(bodyText);
		const safeMessage = redactKeyMaterial(rawMessage, knownSecrets);
		super(`${providerLabel} ${action} call failed with status ${status}: ${safeMessage}`);
		this.name = "DraftingAdapterError";
		this.status = status;
	}
}

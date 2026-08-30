/*
The Anthropic backend behind DraftAdapter. Everything specific to
Anthropic, the endpoint, the auth header, the request and response shape,
stays in this file. Nothing outside it needs to know Anthropic exists.
*/

import type { Draft, DraftAdapter, DraftContext } from "../adapter";
import { getPromptText } from "../prompt-registry";
import { resolveApiKey, type ApiKeySource } from "../keys";
import { parseModelOutput } from "../draft-parsing";
import { DraftingAdapterError } from "./adapter-error";

export interface AnthropicAdapterOptions {
	modelId: string;
	apiKeySource: ApiKeySource;
	envVarName: string;
	/** Read only when apiKeySource is "vault". */
	vaultKey?: string;
	/** Injectable for tests, so a test never makes a real network call. */
	fetchImpl?: typeof fetch;
	readEnv?: (name: string) => string | undefined;
	readKeychain?: (serviceLabel: string) => string | undefined;
}

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SERVICE_LABEL = "Loopback Anthropic API key";
const MAX_TOKENS = 2048;

interface AnthropicResponse {
	content?: { text?: string }[];
}

export class AnthropicAdapter implements DraftAdapter {
	constructor(private readonly options: AnthropicAdapterOptions) {}

	async draft(passage: string, context: DraftContext, promptVersion: string): Promise<Draft[]> {
		const promptText = getPromptText(promptVersion);
		const apiKey = resolveApiKey({
			apiKeySource: this.options.apiKeySource,
			envVarName: this.options.envVarName,
			serviceLabel: SERVICE_LABEL,
			vaultKey: this.options.vaultKey,
			readEnv: this.options.readEnv,
			readKeychain: this.options.readKeychain,
		});

		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(ANTHROPIC_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body: JSON.stringify({
				model: this.options.modelId,
				max_tokens: MAX_TOKENS,
				system: promptText,
				messages: [
					{
						role: "user",
						content: `Source: ${context.source}\nLocation: ${context.location}\n\nPassage:\n${passage}`,
					},
				],
			}),
		});

		if (!response.ok) {
			// The provider's own message is worth surfacing, a usage cap and a
			// bad model id both answer with status 400 and nothing else tells
			// them apart. The body can echo request content back, so the
			// resolved key is redacted out of it before it reaches this message.
			const bodyText = await response.text().catch(() => "");
			throw new DraftingAdapterError("Anthropic", response.status, bodyText, [apiKey]);
		}

		const data = (await response.json()) as AnthropicResponse;
		const text = data.content?.[0]?.text ?? "";
		return parseModelOutput(text).map((card) => ({
			cardText: card.cardText,
			backExtra: card.backExtra,
			promptVersion,
			modelId: this.options.modelId,
		}));
	}
}

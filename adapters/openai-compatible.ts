/*
The OpenAI-compatible backend behind DraftAdapter. This covers OpenRouter
and most locally hosted servers that speak the same chat completions shape,
for free, without a second adapter per provider. Ollama is deliberately not
implemented here; the design note treats it as an open question for later,
not a commitment.
*/

import type { Draft, DraftAdapter, DraftContext } from "../adapter";
import { getPromptText } from "../prompt-registry";
import { resolveApiKey, type ApiKeySource } from "../keys";
import { parseModelOutput } from "../draft-parsing";

export interface OpenAiCompatibleAdapterOptions {
	modelId: string;
	/** For example "https://openrouter.ai/api/v1" or a local server's base URL. */
	baseUrl: string;
	apiKeySource: ApiKeySource;
	envVarName: string;
	/** Read only when apiKeySource is "vault". */
	vaultKey?: string;
	/** Injectable for tests, so a test never makes a real network call. */
	fetchImpl?: typeof fetch;
	readEnv?: (name: string) => string | undefined;
	readKeychain?: (serviceLabel: string) => string | undefined;
}

const SERVICE_LABEL = "Loopback OpenAI-compatible API key";

interface ChatCompletionResponse {
	choices?: { message?: { content?: string } }[];
}

export class OpenAiCompatibleAdapter implements DraftAdapter {
	constructor(private readonly options: OpenAiCompatibleAdapterOptions) {}

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
		const endpoint = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: this.options.modelId,
				messages: [
					{ role: "system", content: promptText },
					{
						role: "user",
						content: `Source: ${context.source}\nLocation: ${context.location}\n\nPassage:\n${passage}`,
					},
				],
			}),
		});

		if (!response.ok) {
			// The status code is safe to report. The response body is not: it can
			// echo request content back, so it never appears in this message.
			throw new Error(`OpenAI-compatible drafting call failed with status ${response.status}`);
		}

		const data = (await response.json()) as ChatCompletionResponse;
		const text = data.choices?.[0]?.message?.content ?? "";
		return parseModelOutput(text).map((card) => ({
			cardText: card.cardText,
			backExtra: card.backExtra,
			promptVersion,
			modelId: this.options.modelId,
		}));
	}
}

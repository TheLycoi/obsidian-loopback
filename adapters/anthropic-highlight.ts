/*
The Anthropic backend behind HighlightAdapter (pdf-source.ts), for
automatic highlight mode over a whole PDF (TCK-073, decision 14). Structured
like adapters/anthropic.ts on purpose: same key resolution, same error
handling, same shape of request, because the only real difference between
drafting one passage and proposing spans across a document is the prompt
and the response shape.

No test in this repository makes a live call through this adapter. The
Anthropic account this project runs under is capped until 2026-09-01
(see the Worker Log for TCK-073), so this is wired and unit tested against
a fake fetch only, the same way adapters/anthropic.ts itself is tested.
Live proof that a real Anthropic call proposes usable spans is outstanding.
*/

import type { HighlightAdapter, PdfPage, SpanProposal } from "../pdf-source";
import { getPromptText, CURRENT_HIGHLIGHT_PROMPT_VERSION } from "../prompt-registry";
import { resolveApiKey, type ApiKeySource } from "../keys";
import { parseHighlightOutput } from "../highlight-parsing";
import { DraftingAdapterError } from "./adapter-error";

export interface AnthropicHighlightAdapterOptions {
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
/** Higher than drafting's MAX_TOKENS: a document's worth of proposed spans is naturally longer than one passage's worth of cards. */
const MAX_TOKENS = 4096;

interface AnthropicResponse {
	content?: { text?: string }[];
}

function renderDocument(pages: PdfPage[]): string {
	return pages.map((page) => `--- page ${page.number} ---\n${page.text}`).join("\n\n");
}

export class AnthropicHighlightAdapter implements HighlightAdapter {
	constructor(private readonly options: AnthropicHighlightAdapterOptions) {}

	async proposeSpans(pages: PdfPage[], prompt?: string): Promise<SpanProposal[]> {
		const promptText = getPromptText(CURRENT_HIGHLIGHT_PROMPT_VERSION);
		const apiKey = resolveApiKey({
			apiKeySource: this.options.apiKeySource,
			envVarName: this.options.envVarName,
			serviceLabel: SERVICE_LABEL,
			vaultKey: this.options.vaultKey,
			readEnv: this.options.readEnv,
			readKeychain: this.options.readKeychain,
		});

		const documentText = renderDocument(pages);
		const userContent = prompt ? `${documentText}\n\nAdditional guidance: ${prompt}` : documentText;

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
				messages: [{ role: "user", content: userContent }],
			}),
		});

		if (!response.ok) {
			// Same reasoning as adapters/anthropic.ts: the provider's own message
			// tells a usage cap apart from a bad model id, and the resolved key
			// is redacted out of it before it reaches this message.
			const bodyText = await response.text().catch(() => "");
			throw new DraftingAdapterError("Anthropic", response.status, bodyText, [apiKey], "highlight");
		}

		const data = (await response.json()) as AnthropicResponse;
		const text = data.content?.[0]?.text ?? "";
		return parseHighlightOutput(text);
	}
}

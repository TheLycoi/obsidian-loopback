/*
Loads a versioned prompt by id. The prompt text lives in prompts/draft-v1.md,
a plain Markdown file in the repo, not a string buried in TypeScript.
esbuild inlines the file's text at build time (see the ".md" loader in
esbuild.config.mjs and in the test:build script in package.json), so the
running plugin needs no extra file on disk at runtime, and the source of
truth for what the model is told stays a file a person can open and diff.

prompts/highlight-v1.md is the same idea for automatic highlight mode
(TCK-073): a different prompt, a different output shape, same registry, so
a caller asking for the wrong version by id gets the same clear error
either way rather than a second, parallel lookup function.
*/

import draftV1 from "./prompts/draft-v1.md";
import highlightV1 from "./prompts/highlight-v1.md";

const PROMPT_VERSIONS: Record<string, string> = {
	"draft-v1": draftV1,
	"highlight-v1": highlightV1,
};

/** The version new drafting calls use unless a caller asks for an older one. */
export const CURRENT_PROMPT_VERSION = "draft-v1";

/** The version new automatic-highlight calls use unless a caller asks for an older one. */
export const CURRENT_HIGHLIGHT_PROMPT_VERSION = "highlight-v1";

export function getPromptText(promptVersion: string): string {
	const text = PROMPT_VERSIONS[promptVersion];
	if (text === undefined) {
		throw new Error(`Unknown prompt version: ${promptVersion}`);
	}
	return text;
}

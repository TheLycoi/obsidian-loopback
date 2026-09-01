/*
Builds the user message both drafting adapters send, so Anthropic and the
OpenAI-compatible backend describe the same DraftContext the same way
rather than drifting apart one field at a time. Everything here is plain
string assembly: no request shape, no auth, no endpoint, which is why it
lives beside the adapters rather than inside adapter.ts itself.

TCK-078 widens this from "Source, Location, Passage" to include the three
optional wiki fields DraftContext now carries, each included only when
present so a context with no wiki data behind it produces the exact same
message this used to build. The labels here match what draft-v1.md and
critique-v1.md tell the model to expect under each heading.
*/

import type { DraftContext } from "../adapter";

export function buildUserMessage(passage: string, context: DraftContext): string {
	// Source and location stay joined by a single newline, matching the
	// message this built before TCK-078, so a context carrying no wiki data
	// produces byte-identical output to before.
	const sections = [`Source: ${context.source}\nLocation: ${context.location}`];

	if (context.sourcePageText) sections.push(`Source page text:\n${context.sourcePageText}`);
	if (context.existingCards) sections.push(`Existing seeds and cards for this page:\n${context.existingCards}`);
	if (context.relatedPages) sections.push(`Related wiki pages:\n${context.relatedPages}`);

	sections.push(`Passage:\n${passage}`);

	return sections.join("\n\n");
}

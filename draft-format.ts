/*
The draft block format: read and write for flashcard-inbox.md, appended
after the capture blocks that capture-format.ts already owns. A draft
references its capture by id rather than repeating the passage, the
source, or the timestamp, since all three already live on the capture
block it came from.

Like capture-format.ts, this module has no dependency on the Obsidian API,
so it can be unit tested with plain Node.
*/

import type { LintFailure } from "./linter";

export type DraftStatus = "draft" | "flagged";

export interface DraftRecord {
	id: string;
	captureId: string;
	status: DraftStatus;
	cardText: string;
	backExtra: string;
	promptVersion: string;
	modelId: string;
	lintFailures: LintFailure[];
}

function serializeLintFailures(failures: LintFailure[]): string {
	return failures.length > 0 ? failures.join(", ") : "none";
}

function deserializeLintFailures(value: string): LintFailure[] {
	if (value.trim().length === 0 || value.trim() === "none") return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0) as LintFailure[];
}

/** Turn one candidate card into the Markdown block appended to the inbox file. */
export function serializeDraft(draft: DraftRecord): string {
	const lines = [
		`### Draft ${draft.id}`,
		"",
		`- id: ${draft.id}`,
		`- capture: ${draft.captureId}`,
		`- status: ${draft.status}`,
		`- promptVersion: ${draft.promptVersion}`,
		`- modelId: ${draft.modelId}`,
		`- lint: ${serializeLintFailures(draft.lintFailures)}`,
		"",
		draft.cardText,
		"",
		`Back: ${draft.backExtra}`,
		"",
		"---",
		"",
	];
	return lines.join("\n");
}

// The attribute lines use [^\n]+ rather than .+ so they cannot cross a line
// even under the dotAll flag below, which the cardText and backExtra groups
// need to span a multi-line quote. Without that restriction, dotAll lets
// the greedy attribute-line quantifier swallow everything up to the last
// block in the file, silently dropping every draft but the last.
const DRAFT_BLOCK_PATTERN = /### Draft (\S+)\n\n((?:- [^\n]+\n)+)\n(.*?)\n\nBack: (.*?)\n\n---\n/gs;

function parseAttributes(block: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const line of block.split("\n")) {
		if (!line.startsWith("- ")) continue;
		const rest = line.slice(2);
		const separator = rest.indexOf(": ");
		if (separator === -1) continue;
		attributes[rest.slice(0, separator)] = rest.slice(separator + 2);
	}
	return attributes;
}

/** Read every draft block out of an inbox file's contents, in file order. */
export function parseDrafts(fileContent: string): DraftRecord[] {
	const drafts: DraftRecord[] = [];
	const normalized = fileContent.replace(/\r\n/g, "\n");
	const pattern = new RegExp(DRAFT_BLOCK_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(normalized)) !== null) {
		const headingId = match[1];
		const attributes = parseAttributes(match[2]);
		drafts.push({
			id: attributes.id ?? headingId,
			captureId: attributes.capture ?? "",
			status: (attributes.status as DraftStatus) ?? "draft",
			promptVersion: attributes.promptVersion ?? "",
			modelId: attributes.modelId ?? "",
			lintFailures: deserializeLintFailures(attributes.lint ?? "none"),
			cardText: match[3],
			backExtra: match[4],
		});
	}
	return drafts;
}

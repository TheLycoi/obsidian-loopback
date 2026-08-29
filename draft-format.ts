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

/**
 * The review queue (a later module) adds three statuses on top of the two
 * the linter writes: "approved" once a human has said yes (clean or after
 * an edit), "exported" once the card is confirmed written to Anki, and
 * "discarded" once a human has said no. No code path may write "approved"
 * or "exported" except the explicit human actions in review-actions.ts and
 * the export step that runs only after a draft is already "approved".
 */
export type DraftStatus = "draft" | "flagged" | "approved" | "exported" | "discarded";

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

/** The exact span of one draft block in a file, plus the record it parses to. */
export interface DraftBlockLocation {
	start: number;
	end: number;
	record: DraftRecord;
}

/**
 * Locate one draft block by id, so the review queue (a later module) can
 * replace exactly that block, in place, without touching anything else in
 * the inbox file. Returns undefined when no block with that id exists,
 * rather than throwing, since the caller (a human action on a draft that
 * may have already been acted on elsewhere) is in a better position to
 * decide what a missing draft means.
 */
export function findDraftBlock(fileContent: string, id: string): DraftBlockLocation | undefined {
	const normalized = fileContent.replace(/\r\n/g, "\n");
	const pattern = new RegExp(DRAFT_BLOCK_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(normalized)) !== null) {
		const headingId = match[1];
		const attributes = parseAttributes(match[2]);
		const recordId = attributes.id ?? headingId;
		if (recordId !== id) continue;
		return {
			start: match.index,
			end: match.index + match[0].length,
			record: {
				id: recordId,
				captureId: attributes.capture ?? "",
				status: (attributes.status as DraftStatus) ?? "draft",
				promptVersion: attributes.promptVersion ?? "",
				modelId: attributes.modelId ?? "",
				lintFailures: deserializeLintFailures(attributes.lint ?? "none"),
				cardText: match[3],
				backExtra: match[4],
			},
		};
	}
	return undefined;
}

/**
 * Replace one draft block, in place, with the serialized form of an updated
 * record. This is the only way review actions change a draft's status or
 * text: the block is found by id and swapped, so every other block in the
 * file, and everything that is not a draft block, is left untouched. When
 * the id does not resolve to a block, the content is returned unchanged
 * rather than throwing, for the same reason findDraftBlock returns
 * undefined instead of throwing.
 */
export function replaceDraftBlock(fileContent: string, id: string, updated: DraftRecord): string {
	const normalized = fileContent.replace(/\r\n/g, "\n");
	const location = findDraftBlock(normalized, id);
	if (!location) return normalized;
	const before = normalized.slice(0, location.start);
	const after = normalized.slice(location.end);
	return before + serializeDraft(updated) + after;
}

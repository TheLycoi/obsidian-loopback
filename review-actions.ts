/*
The only three ways a draft's status can change once a human is looking at
it: approve as written, edit then approve, or discard. There is no fourth
path and no way to reach "approved" without one of the first two running,
which is the code-level half of the human gate the design note calls a hard
requirement. The export step (a later module) only ever reads an already
"approved" draft; it has no way to set that status itself.

Every action here is pure: given the inbox file's text and a draft id, it
returns the updated text plus a disposition log entry, or undefined when the
id does not resolve to a draft. Nothing here touches the filesystem or the
Obsidian API, so it is unit tested the same way draft-format.ts is, with
plain strings.
*/

import { findDraftBlock, replaceDraftBlock, type DraftRecord } from "./draft-format";

export type Disposition = "approved-clean" | "approved-edited" | "discarded";

export interface DispositionLogEntry {
	draftId: string;
	captureId: string;
	disposition: Disposition;
	promptVersion: string;
	modelId: string;
	timestamp: string;
}

export interface ReviewActionResult {
	fileContent: string;
	logEntry: DispositionLogEntry;
}

/** What an edit changes on a draft. Either field left out keeps the drafted text. */
export interface DraftEdit {
	cardText?: string;
	backExtra?: string;
}

type Clock = () => string;

const defaultClock: Clock = () => new Date().toISOString();

function buildLogEntry(record: DraftRecord, disposition: Disposition, clock: Clock): DispositionLogEntry {
	return {
		draftId: record.id,
		captureId: record.captureId,
		disposition,
		promptVersion: record.promptVersion,
		modelId: record.modelId,
		timestamp: clock(),
	};
}

/** Approve a draft exactly as drafted. The only status change here: draft or flagged to approved. */
export function approveDraft(fileContent: string, id: string, clock: Clock = defaultClock): ReviewActionResult | undefined {
	const location = findDraftBlock(fileContent, id);
	if (!location) return undefined;
	const updated: DraftRecord = { ...location.record, status: "approved" };
	return {
		fileContent: replaceDraftBlock(fileContent, id, updated),
		logEntry: buildLogEntry(location.record, "approved-clean", clock),
	};
}

/** Apply a reviewer's edit and approve in the same action. Editing without approving is not a state this module has. */
export function editAndApproveDraft(
	fileContent: string,
	id: string,
	edit: DraftEdit,
	clock: Clock = defaultClock
): ReviewActionResult | undefined {
	const location = findDraftBlock(fileContent, id);
	if (!location) return undefined;
	const updated: DraftRecord = {
		...location.record,
		cardText: edit.cardText ?? location.record.cardText,
		backExtra: edit.backExtra ?? location.record.backExtra,
		status: "approved",
	};
	return {
		fileContent: replaceDraftBlock(fileContent, id, updated),
		logEntry: buildLogEntry(location.record, "approved-edited", clock),
	};
}

/** Discard a draft. The card text and Back Extra are left as they were, since the record stays in the file as a permanent disposition, never deleted. */
export function discardDraft(fileContent: string, id: string, clock: Clock = defaultClock): ReviewActionResult | undefined {
	const location = findDraftBlock(fileContent, id);
	if (!location) return undefined;
	const updated: DraftRecord = { ...location.record, status: "discarded" };
	return {
		fileContent: replaceDraftBlock(fileContent, id, updated),
		logEntry: buildLogEntry(location.record, "discarded", clock),
	};
}

export interface BulkActionResult {
	fileContent: string;
	logEntries: DispositionLogEntry[];
	/** Ids that did not resolve to a draft, so the caller can say which ones were skipped. */
	missingIds: string[];
}

/** Approve every id in the list, each exactly as drafted. An id with no matching draft is recorded in missingIds rather than stopping the batch. */
export function bulkApprove(fileContent: string, ids: string[], clock: Clock = defaultClock): BulkActionResult {
	let content = fileContent;
	const logEntries: DispositionLogEntry[] = [];
	const missingIds: string[] = [];
	for (const id of ids) {
		const result = approveDraft(content, id, clock);
		if (!result) {
			missingIds.push(id);
			continue;
		}
		content = result.fileContent;
		logEntries.push(result.logEntry);
	}
	return { fileContent: content, logEntries, missingIds };
}

/** Discard every id in the list. Same missing-id handling as bulkApprove. */
export function bulkDiscard(fileContent: string, ids: string[], clock: Clock = defaultClock): BulkActionResult {
	let content = fileContent;
	const logEntries: DispositionLogEntry[] = [];
	const missingIds: string[] = [];
	for (const id of ids) {
		const result = discardDraft(content, id, clock);
		if (!result) {
			missingIds.push(id);
			continue;
		}
		content = result.fileContent;
		logEntries.push(result.logEntry);
	}
	return { fileContent: content, logEntries, missingIds };
}

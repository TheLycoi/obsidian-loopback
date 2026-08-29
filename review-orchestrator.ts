/*
The Obsidian-facing half of the review queue: reads and writes the inbox
file and the disposition log, and is the only place review-view.ts calls
into. Every exported function here corresponds to exactly one thing a human
did (pressed approve, pressed edit-and-approve, pressed discard, or ran a
bulk action), and each one logs a disposition and, for an approval, goes on
to call exportApprovedDraft immediately. That immediate export is what
keeps the human gate to a single action: the same key press that approves a
draft is the key press that authorizes the AnkiConnect write, so the
"approve" and "reaches Anki" moments are the same reviewer decision rather
than two separate ones that could drift apart.
*/

import { type App, Notice, TFile, normalizePath } from "obsidian";
import { approveDraft, bulkApprove, bulkDiscard, discardDraft, editAndApproveDraft, type DraftEdit, type DispositionLogEntry } from "./review-actions";
import { appendLogEntries } from "./disposition-log";
import { exportApprovedDraft } from "./export-flow";
import { buildQueue, shouldRefuseCapture as pureShouldRefuseCapture, type QueueModel } from "./review-queue";
import type { LoopbackSettings } from "./settings";

const EMPTY_QUEUE: QueueModel = { staleGroups: [], freshGroups: [], pendingCount: 0, orphanDrafts: [] };

interface InboxHandle {
	file: TFile;
	content: string;
}

async function readInbox(app: App, inboxPath: string): Promise<InboxHandle | undefined> {
	const file = app.vault.getAbstractFileByPath(normalizePath(inboxPath));
	if (!(file instanceof TFile)) return undefined;
	return { file, content: await app.vault.read(file) };
}

async function appendToLog(app: App, settings: LoopbackSettings, entries: DispositionLogEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const path = normalizePath(settings.dispositionLogPath);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const content = await app.vault.read(existing);
		await app.vault.modify(existing, appendLogEntries(content, entries));
	} else {
		await app.vault.create(path, appendLogEntries("", entries));
	}
}

/** The queue model the view renders: empty when there is no inbox file yet. */
export async function loadQueue(app: App, settings: LoopbackSettings): Promise<QueueModel> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) return EMPTY_QUEUE;
	return buildQueue(inbox.content);
}

/** Whether a new capture should be refused right now, per decision 5's 50-draft ceiling. Called by main.ts before a capture is written. */
export async function shouldRefuseCapture(app: App, settings: LoopbackSettings): Promise<boolean> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) return false;
	return pureShouldRefuseCapture(inbox.content);
}

export async function performApprove(app: App, settings: LoopbackSettings, draftId: string): Promise<void> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) {
		new Notice("Loopback: no inbox file to review.");
		return;
	}
	const result = approveDraft(inbox.content, draftId);
	if (!result) {
		new Notice(`Loopback: draft ${draftId} was not found.`);
		return;
	}
	await app.vault.modify(inbox.file, result.fileContent);
	await appendToLog(app, settings, [result.logEntry]);
	await exportApprovedDraft(app, settings, draftId);
}

export async function performEditAndApprove(app: App, settings: LoopbackSettings, draftId: string, edit: DraftEdit): Promise<void> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) {
		new Notice("Loopback: no inbox file to review.");
		return;
	}
	const result = editAndApproveDraft(inbox.content, draftId, edit);
	if (!result) {
		new Notice(`Loopback: draft ${draftId} was not found.`);
		return;
	}
	await app.vault.modify(inbox.file, result.fileContent);
	await appendToLog(app, settings, [result.logEntry]);
	await exportApprovedDraft(app, settings, draftId);
}

export async function performDiscard(app: App, settings: LoopbackSettings, draftId: string): Promise<void> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) {
		new Notice("Loopback: no inbox file to review.");
		return;
	}
	const result = discardDraft(inbox.content, draftId);
	if (!result) {
		new Notice(`Loopback: draft ${draftId} was not found.`);
		return;
	}
	await app.vault.modify(inbox.file, result.fileContent);
	await appendToLog(app, settings, [result.logEntry]);
	new Notice(`Loopback: discarded draft ${draftId}.`);
}

/** Approve every id in the batch, each exactly as drafted, then attempt export for each in turn. */
export async function performBulkApprove(app: App, settings: LoopbackSettings, ids: string[]): Promise<void> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) {
		new Notice("Loopback: no inbox file to review.");
		return;
	}
	const result = bulkApprove(inbox.content, ids);
	await app.vault.modify(inbox.file, result.fileContent);
	await appendToLog(app, settings, result.logEntries);

	let exported = 0;
	let blocked = 0;
	let pending = 0;
	for (const entry of result.logEntries) {
		const outcome = await exportApprovedDraft(app, settings, entry.draftId);
		if (outcome.outcome === "exported") exported += 1;
		else if (outcome.outcome === "duplicate" || outcome.outcome === "deck-forbidden") blocked += 1;
		else if (outcome.outcome === "unreachable") pending += 1;
	}

	new Notice(
		`Loopback: approved ${result.logEntries.length} draft(s). Exported ${exported}, blocked ${blocked}, pending export ${pending}.`
	);
	if (result.missingIds.length > 0) {
		new Notice(`Loopback: ${result.missingIds.length} id(s) in the bulk approve did not resolve to a draft.`);
	}
}

export async function performBulkDiscard(app: App, settings: LoopbackSettings, ids: string[]): Promise<void> {
	const inbox = await readInbox(app, settings.inboxPath);
	if (!inbox) {
		new Notice("Loopback: no inbox file to review.");
		return;
	}
	const result = bulkDiscard(inbox.content, ids);
	await app.vault.modify(inbox.file, result.fileContent);
	await appendToLog(app, settings, result.logEntries);
	new Notice(`Loopback: discarded ${result.logEntries.length} draft(s).`);
	if (result.missingIds.length > 0) {
		new Notice(`Loopback: ${result.missingIds.length} id(s) in the bulk discard did not resolve to a draft.`);
	}
}

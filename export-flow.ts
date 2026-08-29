/*
Exports one already-approved draft to Anki over AnkiConnect, and writes the
seed back to the vault page it came from. This is the only place in the
plugin that calls addNote. It is never called from anywhere except the
review actions in review-orchestrator.ts, each of which runs only in
response to a reviewer pressing a key, so this file is downstream of the
human gate rather than a second way around it.

Order of operations, and why:
1. Sync, best effort. A sync failure (for example, no AnkiWeb login) is
   logged and does not block a local write, since the local collection is
   what the export is actually writing to.
2. Refuse outright if the configured deck starts with "#": that is a
   filtered utility deck Anki rebuilds, never a place to write real cards,
   and this check runs regardless of what Settings holds.
3. Duplicate search across the whole collection, no deck qualifier. A hit
   blocks the write and the Notice says which note it matched.
4. addNote, tagged wiki::<page-slug>.
5. Sync again.
6. Mark the draft "exported" in the inbox, write the seed back to the
   source page, and update that page's cards: frontmatter.

Anki being closed or AnkiConnect being unreachable is caught once, broadly,
around steps 1 through 5: the draft is left exactly as it was ("approved"),
a Notice explains why, and nothing here retries on its own. A human runs
the export action again later, which is what requirement 9 asks for:
lost nothing, no silent retry loop.
*/

import { type App, Notice, TFile, normalizePath } from "obsidian";
import { parseCaptures } from "./capture-format";
import { findDraftBlock, replaceDraftBlock, type DraftRecord } from "./draft-format";
import {
	AnkiConnectError,
	addNote,
	findNotes,
	getDeckNames,
	getNotesInfo,
	syncCollection,
} from "./anki-client";
import { buildDuplicateSearchQuery, buildNoteFields, buildTags, derivePageSlug, detectModelName } from "./anki-note";
import { appendFlashcardSeed, buildMinimalSourcePage, updateCardsFrontmatter } from "./seed-writeback";
import type { LoopbackSettings } from "./settings";

export type ExportOutcome = "exported" | "duplicate" | "unreachable" | "not-found" | "not-approved" | "no-capture" | "deck-forbidden";

export interface ExportResult {
	outcome: ExportOutcome;
	message: string;
}

async function trySync(url: string): Promise<void> {
	try {
		await syncCollection(url);
	} catch (error) {
		// Non-fatal: a sync failure (commonly, no AnkiWeb login) does not mean
		// the local collection is unreachable, and the write below targets the
		// local collection, not AnkiWeb.
		const message = error instanceof Error ? error.message : "unknown sync error";
		console.warn(`Loopback: sync did not complete (${message}). Continuing with the local collection.`);
	}
}

async function describeDuplicate(url: string, noteIds: number[]): Promise<string> {
	try {
		const infos = await getNotesInfo(url, noteIds.slice(0, 1));
		const info = infos[0];
		if (!info) return `note id ${noteIds[0]}`;
		const firstField = Object.values(info.fields)[0];
		const snippet = firstField ? firstField.value.slice(0, 80) : "";
		return `note id ${info.noteId} (${info.modelName}): "${snippet}"`;
	} catch {
		return `note id ${noteIds[0]}`;
	}
}

/**
 * Export one draft by id. The draft must already be "approved," which
 * review-orchestrator.ts guarantees by only ever calling this right after
 * an approve or edit-and-approve action. Reads and writes the inbox file
 * and, on a successful write, the source page as well.
 */
export async function exportApprovedDraft(app: App, settings: LoopbackSettings, draftId: string): Promise<ExportResult> {
	const inboxPath = normalizePath(settings.inboxPath);
	const inboxFile = app.vault.getAbstractFileByPath(inboxPath);
	if (!(inboxFile instanceof TFile)) {
		return { outcome: "not-found", message: "Loopback: no inbox file, nothing to export." };
	}

	const inboxContent = await app.vault.read(inboxFile);
	const location = findDraftBlock(inboxContent, draftId);
	if (!location) {
		return { outcome: "not-found", message: `Loopback: draft ${draftId} not found in the inbox.` };
	}
	if (location.record.status !== "approved") {
		return { outcome: "not-approved", message: `Loopback: draft ${draftId} is not approved, so it was not exported.` };
	}

	const capture = parseCaptures(inboxContent).find((entry) => entry.id === location.record.captureId);
	if (!capture) {
		return { outcome: "no-capture", message: `Loopback: draft ${draftId} has no matching capture; the source passage is unknown.` };
	}

	const deckName = settings.exportDeck;
	if (deckName.startsWith("#")) {
		return {
			outcome: "deck-forbidden",
			message: `Loopback: export refused. "${deckName}" starts with "#" and is a filtered utility deck, never an export target.`,
		};
	}

	const url = settings.ankiConnectUrl;

	try {
		await trySync(url);
		// getDeckNames is called for its side effect of confirming AnkiConnect
		// itself is reachable before the duplicate search runs, so a closed
		// Anki is reported once, clearly, rather than surfacing from whichever
		// call happens to run first.
		await getDeckNames(url);

		const duplicateQuery = buildDuplicateSearchQuery(location.record.cardText);
		const matches = await findNotes(url, duplicateQuery);
		if (matches.length > 0) {
			const description = await describeDuplicate(url, matches);
			return {
				outcome: "duplicate",
				message: `Loopback: export blocked, a duplicate already exists: ${description}.`,
			};
		}

		const modelName = detectModelName(location.record.cardText);
		const fields = buildNoteFields(location.record, modelName);
		const pageSlug = derivePageSlug(capture.source);
		const tags = buildTags(pageSlug);

		const noteId = await addNote(url, { deckName, modelName, fields, tags });
		await trySync(url);

		const exportedRecord: DraftRecord = { ...location.record, status: "exported" };
		const updatedInbox = replaceDraftBlock(inboxContent, draftId, exportedRecord);
		await app.vault.modify(inboxFile, updatedInbox);

		await writeSeedBack(app, capture.source, location.record, deckName, noteId);

		new Notice(`Loopback: exported to Anki (${deckName}, note ${noteId}).`);
		return { outcome: "exported", message: `Loopback: exported draft ${draftId} to Anki as note ${noteId}.` };
	} catch (error) {
		if (error instanceof AnkiConnectError) {
			const message = `Loopback: Anki is unreachable (${error.message}). "${draftId}" stays approved and can be exported again once Anki is open.`;
			new Notice(message);
			return { outcome: "unreachable", message };
		}
		throw error;
	}
}

/** Write the seed bullet and the cards: frontmatter update to the source page, creating a minimal source page first when the recorded source path does not exist, so the seed is never orphaned. */
async function writeSeedBack(app: App, sourcePath: string, record: DraftRecord, deckName: string, noteId: number): Promise<void> {
	const normalizedPath = normalizePath(sourcePath);
	let file = app.vault.getAbstractFileByPath(normalizedPath);

	if (!file) {
		const title = derivePageSlug(sourcePath).replace(/-/g, " ");
		const createdDate = new Date().toISOString().slice(0, 10);
		const folder = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
		if (folder.length > 0 && !app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}
		await app.vault.create(normalizedPath, buildMinimalSourcePage(title, createdDate));
		file = app.vault.getAbstractFileByPath(normalizedPath);
	}

	if (!(file instanceof TFile)) return;

	const pageContent = await app.vault.read(file);
	const withSeed = appendFlashcardSeed(pageContent, { cardText: record.cardText, backExtra: record.backExtra });
	const withFrontmatter = updateCardsFrontmatter(withSeed, { deck: deckName, noteId });
	await app.vault.modify(file, withFrontmatter);
}

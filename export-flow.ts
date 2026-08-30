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
4. addNote, tagged wiki::<page-slug>, or source::<file-slug> for a
   raw-source capture (TCK-072) whose source sits under sources/ with no
   digest page behind it yet.
5. Sync again.
6. Mark the draft "exported" in the inbox. For a page-backed capture, also
   write the seed back to the source page and update its cards:
   frontmatter. A raw-source capture skips this step entirely: sources/ is
   read-only, so there is no page to write a seed to until a human promotes
   the card by writing one.

Anki being closed or AnkiConnect being unreachable is caught once, broadly,
around steps 1 through 5: the draft is left exactly as it was ("approved"),
a Notice explains why, and nothing here retries on its own. A human runs
the export action again later, which is what requirement 9 asks for:
lost nothing, no silent retry loop.

That one catch block first checks whether the AnkiConnectError is Anki's
own duplicate rejection rather than a real connection failure (TCK-070):
step 3's pre-check is expected to catch every real duplicate before addNote
ever runs, but if one still slips through, addNote itself rejects it, and
that rejection is reported as "duplicate," not "unreachable." Everything
else that reaches this catch block, a closed Anki, a wrong port, a stopped
AnkiConnect, still reports "unreachable."
*/

import { type App, Notice, TFile, normalizePath } from "obsidian";
import { isRawSourceCapture, parseCaptures } from "./capture-format";
import { findDraftBlock, replaceDraftBlock, type DraftRecord } from "./draft-format";
import {
	AnkiConnectError,
	addNote,
	findNotes,
	getDeckNames,
	getNotesInfo,
	syncCollection,
} from "./anki-client";
import { buildDuplicateSearchQuery, buildNoteFields, buildSourceTags, buildTags, derivePageSlug, detectModelName } from "./anki-note";
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
 * True when an AnkiConnectError's message is AnkiConnect's own duplicate
 * rejection, "cannot create note because it is a duplicate" (confirmed
 * live against AnkiConnect 6, 2026-08-29), rather than a connection
 * failure. The duplicate pre-check above is expected to catch every real
 * duplicate before addNote ever runs, so this only fires if a duplicate
 * still slips past that search, and it exists so that case is reported
 * honestly instead of as "Anki is unreachable."
 */
function isDuplicateRejection(error: AnkiConnectError): boolean {
	return /duplicate/i.test(error.message);
}

/** Re-runs the duplicate search after addNote itself reports a duplicate, best effort, so the outcome names what it matched instead of just "a duplicate." */
async function describeDuplicateAfterRejection(url: string, cardText: string): Promise<string> {
	try {
		const matches = await findNotes(url, buildDuplicateSearchQuery(cardText));
		if (matches.length > 0) return await describeDuplicate(url, matches);
	} catch {
		// best effort only, addNote already told us it was a duplicate
	}
	return "an existing note";
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
		const fileSlug = derivePageSlug(capture.source);
		// TCK-072: a raw-source capture (sources/..., no digest page written
		// yet) carries source::<file-slug> instead of wiki::<page-slug>, and
		// skips writeSeedBack entirely. writeSeedBack treats capture.source as
		// a Markdown page to read and append a seed bullet to; sources/ holds
		// binary PDFs, so running it against a raw-source capture would read a
		// PDF as text and write Markdown back into it, corrupting the one
		// collection decision 14 requires stay read-only. Promoting a
		// raw-source card to a page-backed one is a human decision (write the
		// digest page, re-derive the seed, retag), not something export does
		// on its own.
		const rawSource = isRawSourceCapture(capture);
		const tags = rawSource ? buildSourceTags(fileSlug) : buildTags(fileSlug);

		const noteId = await addNote(url, { deckName, modelName, fields, tags });
		await trySync(url);

		const exportedRecord: DraftRecord = { ...location.record, status: "exported" };
		const updatedInbox = replaceDraftBlock(inboxContent, draftId, exportedRecord);
		await app.vault.modify(inboxFile, updatedInbox);

		if (!rawSource) {
			await writeSeedBack(app, capture.source, location.record, deckName, noteId);
		}

		new Notice(`Loopback: exported to Anki (${deckName}, note ${noteId}).`);
		return { outcome: "exported", message: `Loopback: exported draft ${draftId} to Anki as note ${noteId}.` };
	} catch (error) {
		if (error instanceof AnkiConnectError) {
			if (isDuplicateRejection(error)) {
				// The pre-check above missed this one; ask Anki again with the
				// same corrected query so the reviewer still learns what it
				// matched, rather than being told the note simply failed.
				const description = await describeDuplicateAfterRejection(url, location.record.cardText);
				const message = `Loopback: export blocked, Anki rejected this note as a duplicate of ${description}.`;
				new Notice(message);
				return { outcome: "duplicate", message };
			}
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

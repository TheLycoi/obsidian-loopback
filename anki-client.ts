/*
A thin AnkiConnect client: one function per action the export flow needs,
each a plain HTTP POST to the configured AnkiConnect URL, following the
same request shape AnkiConnect defines for every action (an action name, a
version, and a params object, answered with a result and an error field).

fetchImpl is injectable, the same pattern adapters/anthropic.ts and
adapters/openai-compatible.ts already use for the drafting backends, so
this file is unit tested against a fake implementation and makes no real
network call in tests.

Every function here can throw. The export flow (a later module) is where
that becomes a Notice instead of an unhandled rejection: Anki closed or
AnkiConnect not installed is a normal, expected failure mode, covered by
requirement 9, not a bug.
*/

const ANKI_CONNECT_VERSION = 6;

export class AnkiConnectError extends Error {}

interface AnkiConnectResponse<T> {
	result: T;
	error: string | null;
}

/**
 * Call one AnkiConnect action. Throws AnkiConnectError both when the HTTP
 * call itself fails (Anki closed, AnkiConnect not installed, wrong URL) and
 * when AnkiConnect answers with a non-null error field, so callers only
 * ever need one catch block for "the export step could not complete."
 */
export async function invokeAnkiConnect<T>(
	url: string,
	action: string,
	params: Record<string, unknown> = {},
	fetchImpl: typeof fetch = fetch
): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown network error";
		throw new AnkiConnectError(`Could not reach AnkiConnect at ${url}: ${message}`);
	}

	if (!response.ok) {
		throw new AnkiConnectError(`AnkiConnect at ${url} answered with HTTP status ${response.status}`);
	}

	const data = (await response.json()) as AnkiConnectResponse<T>;
	if (data.error) {
		throw new AnkiConnectError(`AnkiConnect action "${action}" failed: ${data.error}`);
	}
	return data.result;
}

/** Push local changes and pull remote ones through AnkiWeb, per section 3 of CLAUDE.md: sync before reading collection state and again after writing. */
export function syncCollection(url: string, fetchImpl: typeof fetch = fetch): Promise<null> {
	return invokeAnkiConnect<null>(url, "sync", {}, fetchImpl);
}

/** Every deck name in the collection, used to confirm the export target exists and does not start with "#" before anything is written to it. */
export function getDeckNames(url: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	return invokeAnkiConnect<string[]>(url, "deckNames", {}, fetchImpl);
}

/**
 * Note ids matching an Anki search query. Called with a query that carries
 * no deck: qualifier for the duplicate search, so the search covers the
 * whole collection, per the ticket's constraint and decision 2's
 * requirement that duplicate search never be scoped to just the target deck.
 */
export function findNotes(url: string, query: string, fetchImpl: typeof fetch = fetch): Promise<number[]> {
	return invokeAnkiConnect<number[]>(url, "findNotes", { query }, fetchImpl);
}

export interface NoteInfo {
	noteId: number;
	modelName: string;
	tags: string[];
	fields: Record<string, { value: string; order: number }>;
}

/** Full field content for a set of note ids, used to describe what a duplicate search matched. */
export function getNotesInfo(url: string, noteIds: number[], fetchImpl: typeof fetch = fetch): Promise<NoteInfo[]> {
	return invokeAnkiConnect<NoteInfo[]>(url, "notesInfo", { notes: noteIds }, fetchImpl);
}

export interface AddNoteRequest {
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	tags: string[];
}

/** Create one note. Returns the new note id. This is the only function in this file that writes to the collection. */
export function addNote(url: string, note: AddNoteRequest, fetchImpl: typeof fetch = fetch): Promise<number> {
	return invokeAnkiConnect<number>(url, "addNote", { note }, fetchImpl);
}

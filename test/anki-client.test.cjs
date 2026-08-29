/*
Tests for anki-client.ts. Every test injects a fake fetch, the same pattern
adapters/anthropic.ts and adapters/openai-compatible.ts use for their own
network calls, so nothing here makes a real HTTP request or depends on Anki
actually running.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	invokeAnkiConnect,
	AnkiConnectError,
	syncCollection,
	getDeckNames,
	findNotes,
	getNotesInfo,
	addNote,
} = require("../.test-build/anki-client.cjs");

function okFetch(result) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) });
		return { ok: true, status: 200, json: async () => ({ result, error: null }) };
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

function errorFetch(errorMessage) {
	return async () => ({ ok: true, status: 200, json: async () => ({ result: null, error: errorMessage }) });
}

function httpFailureFetch(status) {
	return async () => ({ ok: false, status, json: async () => ({ result: null, error: null }) });
}

function networkFailureFetch(message) {
	return async () => {
		throw new Error(message);
	};
}

test("invokeAnkiConnect resolves with the result field on a clean response", async () => {
	const fetchImpl = okFetch(["All::2 Default::Wiki"]);
	const result = await invokeAnkiConnect("http://localhost:8765", "deckNames", {}, fetchImpl);
	assert.deepEqual(result, ["All::2 Default::Wiki"]);
	assert.equal(fetchImpl.calls[0].body.action, "deckNames");
	assert.equal(fetchImpl.calls[0].body.version, 6);
});

test("invokeAnkiConnect throws AnkiConnectError when AnkiConnect's own error field is set", async () => {
	await assert.rejects(
		() => invokeAnkiConnect("http://localhost:8765", "addNote", {}, errorFetch("cannot create note because it is a duplicate")),
		AnkiConnectError
	);
});

test("invokeAnkiConnect throws AnkiConnectError on a non-ok HTTP response", async () => {
	await assert.rejects(() => invokeAnkiConnect("http://localhost:8765", "sync", {}, httpFailureFetch(500)), AnkiConnectError);
});

test("invokeAnkiConnect throws AnkiConnectError, naming the url, when the fetch itself fails", async () => {
	try {
		await invokeAnkiConnect("http://localhost:8765", "version", {}, networkFailureFetch("connect ECONNREFUSED"));
		assert.fail("expected invokeAnkiConnect to throw");
	} catch (error) {
		assert.ok(error instanceof AnkiConnectError);
		assert.ok(error.message.includes("http://localhost:8765"));
	}
});

test("syncCollection calls the sync action", async () => {
	const fetchImpl = okFetch(null);
	await syncCollection("http://localhost:8765", fetchImpl);
	assert.equal(fetchImpl.calls[0].body.action, "sync");
});

test("getDeckNames calls the deckNames action", async () => {
	const fetchImpl = okFetch(["All::2 Default::Wiki"]);
	const decks = await getDeckNames("http://localhost:8765", fetchImpl);
	assert.equal(fetchImpl.calls[0].body.action, "deckNames");
	assert.deepEqual(decks, ["All::2 Default::Wiki"]);
});

test("findNotes sends the query and returns the matching note ids", async () => {
	const fetchImpl = okFetch([111, 222]);
	const ids = await findNotes("http://localhost:8765", '"exact phrase"', fetchImpl);
	assert.equal(fetchImpl.calls[0].body.action, "findNotes");
	assert.equal(fetchImpl.calls[0].body.params.query, '"exact phrase"');
	assert.deepEqual(ids, [111, 222]);
});

test("findNotes never adds a deck: qualifier of its own, so the caller's query decides the search scope", async () => {
	const fetchImpl = okFetch([]);
	await findNotes("http://localhost:8765", '"exact phrase"', fetchImpl);
	assert.ok(!fetchImpl.calls[0].body.params.query.includes("deck:"));
});

test("getNotesInfo requests info for the given note ids", async () => {
	const fetchImpl = okFetch([{ noteId: 111, modelName: "Cloze", tags: ["wiki::example"], fields: {} }]);
	const infos = await getNotesInfo("http://localhost:8765", [111], fetchImpl);
	assert.equal(fetchImpl.calls[0].body.action, "notesInfo");
	assert.deepEqual(fetchImpl.calls[0].body.params.notes, [111]);
	assert.equal(infos[0].noteId, 111);
});

test("addNote sends the full note payload and returns the new note id", async () => {
	const fetchImpl = okFetch(999);
	const note = { deckName: "All::2 Default::Wiki", modelName: "Cloze", fields: { Text: "front", "Back Extra": "back" }, tags: ["wiki::example"] };
	const noteId = await addNote("http://localhost:8765", note, fetchImpl);

	assert.equal(fetchImpl.calls[0].body.action, "addNote");
	assert.deepEqual(fetchImpl.calls[0].body.params.note, note);
	assert.equal(noteId, 999);
});

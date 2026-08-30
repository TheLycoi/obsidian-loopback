/*
Tests for export-flow.ts, the shipped exportApprovedDraft function itself,
bundled by esbuild with "obsidian" marked external (the same test:build
pattern every other module here uses), and driven through a Module._load
stub that supplies a minimal Notice, TFile, and normalizePath in place of
the real Obsidian API, plus an in-memory vault shim in place of a real
vault. No hand-rolled reimplementation of exportApprovedDraft lives here:
this file loads and calls the real, unmodified function.

Every test in this file injects a fake fetch (global.fetch), so nothing
here makes a real network call or depends on Anki running. The live proof
that a real AnkiConnect actually returns "duplicate" for a byte-identical
cloze card, not "unreachable", is recorded in the TCK-070 Worker Log, since
that proof needs a running Anki and a scratch deck, which a unit test
cannot provide on its own.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { serializeCapture } = require("../.test-build/capture-format.cjs");
const { serializeDraft } = require("../.test-build/draft-format.cjs");

// Minimal stand-ins for the three Obsidian exports export-flow.ts uses at
// the value level. "App" is imported with `import type`, so it is erased
// at compile time and never reaches this stub.
class FakeNotice {
	constructor(message) {
		this.message = message;
	}
}
class FakeTFile {
	constructor(path) {
		this.path = path;
	}
}
function fakeNormalizePath(path) {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}
const obsidianStub = { Notice: FakeNotice, TFile: FakeTFile, normalizePath: fakeNormalizePath };

// export-flow.cjs was bundled with --external:obsidian, so its own
// `require("obsidian")` call reaches Node's module loader at run time. This
// intercepts that one request and answers with the stub above, leaving
// every other require (node:test, node:assert, and so on) untouched.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.apply(this, arguments);
};
const { exportApprovedDraft } = require("../.test-build/export-flow.cjs");
Module._load = originalLoad;

/** An in-memory vault: a Map of path to file content, wearing just enough of the Vault interface for exportApprovedDraft and writeSeedBack to run against it. */
function makeVault(initialFiles) {
	const files = new Map(initialFiles);
	return {
		files,
		getAbstractFileByPath(path) {
			return files.has(path) ? new FakeTFile(path) : null;
		},
		async read(file) {
			return files.get(file.path);
		},
		async modify(file, content) {
			files.set(file.path, content);
		},
		async create(path, content) {
			files.set(path, content);
			return new FakeTFile(path);
		},
		async createFolder() {
			// Folders are not modeled; writeSeedBack only checks for a truthy
			// abstract file at the folder path before calling this.
		},
	};
}

function baseSettings(overrides) {
	return {
		inboxPath: "flashcard-inbox.md",
		ankiConnectUrl: "http://localhost:8765",
		exportDeck: "All::2 Default::Wiki",
		...overrides,
	};
}

/** One capture and one approved draft, serialized with the real format modules, so the fixture is exactly what the shipped parser expects. */
function buildInbox({ captureId, source, draftId, cardText, backExtra }) {
	const capture = serializeCapture({
		id: captureId,
		status: "captured",
		captured: "2026-08-29T00:00:00.000Z",
		source,
		location: "",
		quote: "Fixture passage, not read by export-flow.ts.",
	});
	const draft = serializeDraft({
		id: draftId,
		captureId,
		status: "approved",
		cardText,
		backExtra,
		promptVersion: "v1",
		modelId: "fixture-model",
		lintFailures: [],
	});
	return capture + draft;
}

function fakeFetch(responder) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		return responder(body, calls);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

function jsonOk(result) {
	return { ok: true, status: 200, json: async () => ({ result, error: null }) };
}

function jsonError(errorMessage) {
	return { ok: true, status: 200, json: async () => ({ result: null, error: errorMessage }) };
}

test("a byte-identical cloze duplicate is caught before addNote runs, and returns outcome duplicate", async () => {
	const inbox = buildInbox({
		captureId: "cap-1",
		source: "wiki/example.md",
		draftId: "draft-1",
		cardText: "The {{c1::posterior pituitary}} releases {{c2::ADH}}.",
		backExtra: "Stored there, made in the hypothalamus.",
	});
	const vault = makeVault([["flashcard-inbox.md", inbox]]);
	const app = { vault };

	let addNoteCalled = false;
	global.fetch = fakeFetch((body) => {
		if (body.action === "sync") return jsonOk(null);
		if (body.action === "deckNames") return jsonOk(["All::2 Default::Wiki"]);
		if (body.action === "findNotes") {
			// The fixed query must still carry the raw cloze markup for this
			// assertion to mean anything: fail loudly if a future change goes
			// back to searching stripped text.
			assert.ok(body.params.query.includes("c1"), "duplicate query lost the cloze markup");
			return jsonOk([555]);
		}
		if (body.action === "notesInfo") {
			return jsonOk([{ noteId: 555, modelName: "Cloze", tags: [], fields: { Text: { value: "The {{c1::posterior pituitary}} releases {{c2::ADH}}.", order: 0 } } }]);
		}
		if (body.action === "addNote") {
			addNoteCalled = true;
			return jsonOk(999);
		}
		throw new Error(`unexpected action ${body.action}`);
	});

	const result = await exportApprovedDraft(app, baseSettings(), "draft-1");

	assert.equal(result.outcome, "duplicate");
	assert.match(result.message, /555/);
	assert.equal(addNoteCalled, false, "addNote must not run once the pre-check finds a duplicate");
});

test("a genuine connection failure still returns outcome unreachable, not duplicate", async () => {
	const inbox = buildInbox({
		captureId: "cap-2",
		source: "wiki/example.md",
		draftId: "draft-2",
		cardText: "The {{c1::adrenal cortex}} makes {{c2::cortisol}}.",
		backExtra: "Under ACTH control.",
	});
	const vault = makeVault([["flashcard-inbox.md", inbox]]);
	const app = { vault };

	global.fetch = fakeFetch((body) => {
		if (body.action === "sync") throw new Error("connect ECONNREFUSED");
		throw new Error("connect ECONNREFUSED");
	});

	const result = await exportApprovedDraft(app, baseSettings(), "draft-2");

	assert.equal(result.outcome, "unreachable");
	assert.match(result.message, /unreachable/);
});

test("addNote's own duplicate rejection, arriving after the pre-check missed it, still reports outcome duplicate and names the match", () => {
	// This is the defense-in-depth path: the pre-check's findNotes call
	// returns no match (simulating some future case the search still misses),
	// addNote itself is then rejected as a duplicate, and the catch block
	// must recognize that rejection rather than reporting "unreachable" the
	// way the pre-TCK-070 code did for every AnkiConnectError alike.
	return (async () => {
		const inbox = buildInbox({
			captureId: "cap-3",
			source: "wiki/example.md",
			draftId: "draft-3",
			cardText: "The {{c1::thyroid}} makes {{c2::T4}}.",
			backExtra: "Under TSH control.",
		});
		const vault = makeVault([["flashcard-inbox.md", inbox]]);
		const app = { vault };

		let findNotesCallCount = 0;
		global.fetch = fakeFetch((body) => {
			if (body.action === "sync") return jsonOk(null);
			if (body.action === "deckNames") return jsonOk(["All::2 Default::Wiki"]);
			if (body.action === "findNotes") {
				findNotesCallCount += 1;
				// First call: the pre-check, reports no match. Second call: the
				// re-check after addNote's own rejection, reports the match.
				return jsonOk(findNotesCallCount === 1 ? [] : [777]);
			}
			if (body.action === "notesInfo") {
				return jsonOk([{ noteId: 777, modelName: "Cloze", tags: [], fields: { Text: { value: "The {{c1::thyroid}} makes {{c2::T4}}.", order: 0 } } }]);
			}
			if (body.action === "addNote") return jsonError("cannot create note because it is a duplicate");
			throw new Error(`unexpected action ${body.action}`);
		});

		const result = await exportApprovedDraft(app, baseSettings(), "draft-3");

		assert.equal(result.outcome, "duplicate");
		assert.match(result.message, /777/);
		assert.equal(findNotesCallCount, 2);
	})();
});

test("a non-duplicate AnkiConnect error from addNote (for example, a malformed note) still reports outcome unreachable", async () => {
	const inbox = buildInbox({
		captureId: "cap-4",
		source: "wiki/example.md",
		draftId: "draft-4",
		cardText: "What releases ADH?",
		backExtra: "The posterior pituitary.",
	});
	const vault = makeVault([["flashcard-inbox.md", inbox]]);
	const app = { vault };

	global.fetch = fakeFetch((body) => {
		if (body.action === "sync") return jsonOk(null);
		if (body.action === "deckNames") return jsonOk(["All::2 Default::Wiki"]);
		if (body.action === "findNotes") return jsonOk([]);
		if (body.action === "addNote") return jsonError("model was not found: Nonexistent");
		throw new Error(`unexpected action ${body.action}`);
	});

	const result = await exportApprovedDraft(app, baseSettings(), "draft-4");

	assert.equal(result.outcome, "unreachable");
});

// TCK-072: a raw-source capture (source under sources/) must export tagged
// source::<file-slug>, not wiki::<page-slug>, and must never touch the raw
// file itself. Before this ticket's fix, writeSeedBack ran unconditionally
// and would have read the "PDF" as text and appended a Markdown seed
// section into it, since capture.source pointed straight at the raw file.
test("a raw-source draft exports tagged source::<file-slug> and never touches the file under sources/", async () => {
	const inbox = buildInbox({
		captureId: "cap-raw",
		source: "sources/fphar-08-00438.pdf",
		draftId: "draft-raw",
		cardText: "The {{c1::vagus nerve}} carries {{c2::parasympathetic}} signals.",
		backExtra: "Cranial nerve X.",
	});
	// Stands in for the real binary PDF: opaque content that would not
	// survive being read as Markdown and re-written with a seed appended.
	const rawFileContent = "%PDF-1.4 fixture bytes, not real PDF content, not to be touched";
	const vault = makeVault([
		["flashcard-inbox.md", inbox],
		["sources/fphar-08-00438.pdf", rawFileContent],
	]);
	const app = { vault };

	let addNoteBody;
	global.fetch = fakeFetch((body) => {
		if (body.action === "sync") return jsonOk(null);
		if (body.action === "deckNames") return jsonOk(["All::2 Default::Wiki"]);
		if (body.action === "findNotes") return jsonOk([]);
		if (body.action === "addNote") {
			addNoteBody = body.params.note;
			return jsonOk(654);
		}
		throw new Error(`unexpected action ${body.action}`);
	});

	const result = await exportApprovedDraft(app, baseSettings(), "draft-raw");

	assert.equal(result.outcome, "exported");
	assert.deepEqual(addNoteBody.tags, ["source::fphar-08-00438"]);
	assert.equal(vault.files.get("sources/fphar-08-00438.pdf"), rawFileContent, "the raw source file must be byte-identical after export");
});

test("a Basic card (no cloze markup) still exports cleanly through the same duplicate pre-check", async () => {
	const inbox = buildInbox({
		captureId: "cap-5",
		source: "wiki/example.md",
		draftId: "draft-5",
		cardText: "What releases ADH?",
		backExtra: "The posterior pituitary.",
	});
	const vault = makeVault([["flashcard-inbox.md", inbox]]);
	const app = { vault };

	let addNoteBody;
	global.fetch = fakeFetch((body) => {
		if (body.action === "sync") return jsonOk(null);
		if (body.action === "deckNames") return jsonOk(["All::2 Default::Wiki"]);
		if (body.action === "findNotes") return jsonOk([]);
		if (body.action === "addNote") {
			addNoteBody = body.params.note;
			return jsonOk(321);
		}
		throw new Error(`unexpected action ${body.action}`);
	});

	const result = await exportApprovedDraft(app, baseSettings(), "draft-5");

	assert.equal(result.outcome, "exported");
	assert.equal(addNoteBody.modelName, "Basic");
	assert.deepEqual(addNoteBody.fields, { Front: "What releases ADH?", Back: "The posterior pituitary." });
});

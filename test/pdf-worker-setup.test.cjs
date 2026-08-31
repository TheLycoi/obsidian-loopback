/*
Test for pdf-worker-setup.ts: the fix for pdf-parse's browser build trying,
by default, to load its worker script from a path resolved against
window.location, a mechanism with nothing correct to resolve against inside
an Obsidian plugin (see the module comment in pdf-worker-setup.ts and the
Worker Log for TCK-073 for the full story).

This test proves the mechanism, not the plugin: importing the worker script
for its side effect really does set globalThis.pdfjsWorker.WorkerMessageHandler
to a function, both when esbuild bundles it (matching what actually ships in
main.js) and when the bundle is require()'d under Node. It does not, and
cannot from this test file, prove that a real Obsidian renderer resolves
this identically; that is the outstanding piece of live proof this ticket
could not close, same as automatic highlight mode.
*/

const test = require("node:test");
const assert = require("node:assert/strict");

test("importing pdf-worker-setup.cjs sets globalThis.pdfjsWorker.WorkerMessageHandler to a function", () => {
	// A fresh property each run, so an earlier test file in the same process
	// that happened to load pdfjs some other way cannot make this pass for
	// the wrong reason.
	delete globalThis.pdfjsWorker;
	assert.equal(typeof globalThis.pdfjsWorker, "undefined");

	require("../.test-build/pdf-worker-setup.cjs");

	assert.equal(typeof globalThis.pdfjsWorker, "object");
	assert.equal(typeof globalThis.pdfjsWorker.WorkerMessageHandler, "function");
});

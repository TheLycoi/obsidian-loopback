/*
Registers pdf.js's worker message handler on globalThis before this plugin
ever constructs a PDFParse instance (pdf-source.ts). Importing this module
for its side effect is the whole point; nothing here is called directly.

Why this exists: pdf-source.ts extracts text through pdf-parse, and esbuild's
default (browser) platform resolves pdf-parse to its "browser" export
condition, a bundle built on pdfjs-dist. Left to its own defaults, pdfjs
tries to load its worker script, a separate multi-megabyte file, from a path
resolved against window.location, a mechanism built for a page served over
http or https by a web server. An Obsidian plugin is require()'d from its
own install directory with no server in front of it, so that default has
nothing correct to resolve against; pdf-parse's own README says as much:
"For browser build, set the web worker explicitly."

The fix sidesteps path resolution rather than trying to get it right.
pdfjs-dist's worker script, run anywhere, sets a global itself: its own
last line is `globalThis.pdfjsWorker = { WorkerMessageHandler }`. Before
trying to load a worker file at all, pdfjs checks whether that global is
already set, and if it is, it runs the parse in the main thread using it
directly, no file load, no path, no window.location involved. Importing the
worker script here for its side effect runs that same last line as part of
this bundle's own load, at plugin startup, so the check always finds it
already set by the time any PDF is parsed.

pdfjs-dist is pinned as a direct dependency in package.json at the exact
version pdf-parse itself depends on (both currently 5.4.296), because pdfjs
rejects a main-thread and worker build at different versions; letting this
drift to whatever pdf-parse's own dependency happens to resolve to on a
fresh install would silently break this fix on a version bump neither file
changed.

This has been verified two ways: esbuild bundles this import with no
unresolved requires (pdf.worker.min.mjs itself imports nothing), and
test/pdf-worker-setup.test.cjs bundles and requires it under Node and
asserts globalThis.pdfjsWorker.WorkerMessageHandler becomes a function. What
has not been verified is pdf-parse extracting a real PDF's text inside an
actual running Obsidian instance; see the Worker Log for TCK-073.
*/

import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";

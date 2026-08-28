# Loopback

An Obsidian plugin that captures a highlighted passage, with its source
attached, into a flashcard inbox. Loopback is one half of a two-part tool.
The other half, an Anki add-on, reads a card's review history and flags the
vault page that produced it when the card keeps failing. This repository
covers the plugin only.

This ticket builds the first and smallest piece: capture. It has to work
when everything else is broken, so it makes no network call and depends on
nothing outside the vault. Highlight a passage, press one key, and the
passage lands in a file with its provenance attached. Drafting candidate
cards from that passage, and exporting approved cards to Anki, are separate
pieces built on top of this one and are not in this repository yet.

## What it does today

- Command: "Capture selection." Select text in an open note, run the
  command, and the selection is appended to the inbox file at the vault
  root, along with the file it came from, the nearest heading or a line
  number, and the time of capture.
- Default hotkey: Cmd+Shift+L on macOS, Ctrl+Shift+L elsewhere. Reassign it
  from Settings, Hotkeys, like any other command.
- Capturing with no selection does nothing to the inbox file. A notice says
  there was nothing to capture.
- A settings tab holds three fields for later use: the inbox file path, the
  source the drafting tool will eventually read an API key from, and the
  AnkiConnect URL the export step will eventually call. None of the three
  is used by capture. No key is read, stored, or logged anywhere in this
  repository.

## What it deliberately does not do

No model call, no AnkiConnect call, no document parsing, no upload step.
Capture is local disk I/O only: read the selection, write a block, show a
notice. That is the entire latency budget, and it is why capture can stay
under one second from keystroke to confirmation even when the network is
down or Anki is closed.

## The capture block format

This format is a contract, not an implementation detail. The drafting tool
and the inbox review view both parse this file, so any change to the shape
below has to update all three places at once: this README, the writer in
`capture-format.ts`, and every reader downstream.

The inbox file, `flashcard-inbox.md` by default, is plain Markdown. It is
meant to be opened, read, and hand-edited by the vault owner when the plugin
is not available. Each capture is one block, appended to the end of the
file, shaped like this:

```
## Capture 20260827T153045123-ab12cd

- id: 20260827T153045123-ab12cd
- status: captured
- captured: 2026-08-27T15:30:45.123Z
- source: wiki/concepts/example.md
- location: Some heading

> The exact quoted passage, reproduced verbatim.

---

```

Field by field:

- The heading line carries the id a second time, so the block is readable
  and locatable even by a person skimming headings only.
- `id` is generated at capture time: a compressed ISO timestamp followed by
  a short random suffix, so two captures in the same millisecond still get
  different ids. Nothing downstream should assume the id is anything more
  structured than a stable, unique string.
- `status` starts at `captured`. Later tickets add further values as a
  draft moves through the review queue. This ticket only ever writes
  `captured`.
- `captured` is the ISO 8601 capture timestamp, in UTC.
- `source` is the vault-relative path to the file the passage was
  highlighted in.
- `location` is the text of the nearest Markdown heading above the
  selection, with the leading hash marks stripped. When no heading precedes
  the selection, this is a 1-indexed line number instead, written as
  `line N`.
- The quoted passage follows the attribute list after a blank line, as a
  Markdown blockquote, one `>` per line of the original selection. A blank
  line inside a multi-paragraph passage is written as a bare `>` so the
  round trip preserves paragraph breaks.
- A block ends with a blank line, a `---` rule, and another blank line,
  which separates it from the next block and doubles as a visual break when
  reading the file directly.

Two fields are named in the design note but intentionally absent here:
`modelId` and `promptVersion`. Those belong to the drafting step, which does
not exist in this repository. A field this ticket cannot fill in honestly is
left out of the block entirely, not written as an empty string, so a
downstream parser can tell the difference between "not yet drafted" and
"drafted with no recorded model."

## Settings

- **Inbox file path.** Vault-relative path to the file captures are
  appended to. Defaults to `flashcard-inbox.md` at the vault root.
- **API key source.** Where a later version of this plugin will read the
  drafting model's API key from: an environment variable, the OS keychain,
  or a value stored in the vault. Defaults to the environment variable.
  This vault syncs through iCloud, so a key stored in the vault, whether in
  `data.json` or in a note, is replicated in plaintext to every device and
  into every backup of the vault. The in-vault option exists for
  completeness and carries this warning in the settings tab itself. This
  ticket does not read a key from any of the three sources.
- **AnkiConnect URL.** The address a later export step will call. Defaults
  to `http://localhost:8765`, the AnkiConnect default. Not used by capture.

## Development

```
npm install
npm run build
```

`npm run build` type-checks with `tsc` and bundles `main.ts` into `main.js`
with esbuild. `npm run dev` runs the same bundler in watch mode for local
iteration.

```
npm test
```

Bundles `capture-format.ts` to CommonJS and runs the round-trip test in
`test/capture-format.test.cjs` with Node's built-in test runner. The test
covers a single capture, a multi-line quote with an internal blank line,
two captures appended to the same file, and id uniqueness across repeated
calls.

## Installing into a vault

This repository does not install itself into any vault. To try it, copy
`manifest.json`, `main.js`, and (if present) `styles.css` into
`<vault>/.obsidian/plugins/loopback/` after running `npm run build`, then
enable it from Community Plugins, Installed Plugins in Obsidian. Installing
the plugin into a specific vault is a decision for whoever owns that vault,
not something this repository does on its own.

## License

MIT. See `LICENSE`.

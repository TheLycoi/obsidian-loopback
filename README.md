# Loopback

An Obsidian plugin that captures a highlighted passage, with its source
attached, into a flashcard inbox, and drafts candidate cards from that
passage. Loopback is one half of a two-part tool. The other half, an Anki
add-on, reads a card's review history and flags the vault page that
produced it when the card keeps failing. This repository covers the plugin
only.

The first and smallest piece is capture. It has to work when everything
else is broken, so it makes no network call and depends on nothing outside
the vault. Highlight a passage, press one key, and the passage lands in a
file with its provenance attached. Drafting sits on top of capture and runs
on its own command, so a slow or failing model call can never add latency
to a capture. A review queue sits on top of drafting: a human looks at each
candidate card beside the passage it came from and approves, edits then
approves, or discards it. Approving is the one action that sends a card to
Anki over AnkiConnect. Nothing in this repository writes a card any other
way.

## What it does today

- Command: "Capture selection." Select text in an open note, run the
  command, and the selection is appended to the inbox file at the vault
  root, along with the file it came from, the nearest heading or a line
  number, and the time of capture.
- Default hotkey: Cmd+Shift+L on macOS, Ctrl+Shift+L elsewhere. Reassign it
  from Settings, Hotkeys, like any other command.
- Capturing with no selection does nothing to the inbox file. A notice says
  there was nothing to capture.
- Command: "Draft pending captures." Reads every capture in the inbox
  still marked `captured`, sends its passage to whichever provider is
  configured in Settings, and appends the candidate cards it gets back as
  draft blocks in the same inbox file. See "Drafting" below.
- Command: "Open review queue." Opens a view listing every pending draft
  beside the source passage it came from. Approve, edit then approve, or
  discard each one; bulk approve and bulk discard act on whatever is
  checked. See "Review queue and export" below.
- A settings tab holds the inbox file path, the drafting provider and model
  id, where the API key is read from, the AnkiConnect URL, the export deck,
  and the disposition log path.

## What it deliberately does not do

Capture makes no model call, no AnkiConnect call, no document parsing, no
upload step. It is local disk I/O only: read the selection, write a block,
show a notice. That is the entire latency budget, and it is why capture can
stay under one second from keystroke to confirmation even when the network
is down or Anki is closed. Drafting does make a model call, but only on its
own command, never on the capture path, so capture's latency is unaffected
by whether drafting is slow, failing, or misconfigured.

No card reaches Anki without a human pressing approve on that specific
draft in the review queue. There is no setting, confidence threshold, or
batch job that approves a card on its own; drafting only ever proposes.

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

Two fields are named in the design note but intentionally absent from the
capture block: `modelId` and `promptVersion`. Those belong to a draft, not
a capture, and are recorded on the draft block described below. A field a
given block cannot fill in honestly is left out entirely, not written as an
empty string, so a downstream parser can tell the difference between "not
yet drafted" and "drafted with no recorded model."

## Drafting

The "Draft pending captures" command reads the inbox, finds every capture
still marked `captured`, and sends its passage to a model through a
provider adapter. The adapter interface is one method,
`draft(passage, context, promptVersion) -> Draft[]`, so everything specific
to a provider (endpoint, auth header, request and response shape) stays out
of the rest of the plugin. Two backends exist behind it: Anthropic and an
OpenAI-compatible backend that covers OpenRouter and most locally hosted
servers speaking the same chat completions shape. Ollama is not implemented.

The prompt is a versioned file, `prompts/draft-v1.md`, not a string in
TypeScript, so the source of truth for what the model is told is a file a
person can open and diff. Every draft records the prompt version and the
model id that produced it, so a change in card quality can be traced to a
change in the prompt.

Before a passage goes to the model, it is checked for length and split
along paragraph breaks, and sentence breaks within an over-length
paragraph, rather than sent whole. After the model answers, every candidate
card runs through a deterministic linter with no model call and no network
call. The linter checks cloze count (two to four, numbered c1 upward with
no gaps), whether a cloze holds an atom or a whole clause of framing,
whether the Back Extra restates the cloze instead of explaining it, and a
length ceiling. A card that fails is written to the inbox flagged, not
dropped, since a silently discarded draft teaches nothing about the prompt.

Drafting never runs as part of capture and never blocks it. It is its own
command, so a slow or failing model call adds no latency to the one-second
capture budget.

Key resolution follows the order in Settings: an environment variable
first, the OS keychain second, and an in-vault setting last, read only when
the owner has explicitly chosen it. A key is never logged, never written to
the inbox file, and never included in an error message.

## Review queue and export

The "Open review queue" command opens a view listing every draft still
marked `draft` or `flagged`, each beside the source passage and location
its capture recorded. Drafts older than 30 days appear in a stale section
at the top, since an inbox that only fills is a failure on its own and the
fix is visibility, not silent expiry: nothing here ever deletes a draft or
a capture. Capturing a new passage is refused, with a Notice explaining
why, once more than 50 drafts are pending; the fix is clearing the queue,
not raising the ceiling.

Three actions exist per draft, and no others:

- **Approve.** One key ("a" on a focused draft row, or a button) sends the
  draft to Anki exactly as drafted.
- **Edit then approve.** The card text and Back Extra are editable inline;
  saving approves the edited version.
- **Discard.** One key ("d," or a button). The draft's text is kept in the
  inbox, marked `discarded`, never deleted.

Bulk approve and bulk discard act on every checked draft. Approving, alone
or in bulk, is the only way a card reaches Anki: it is the reviewer's own
action, not a setting, and there is no confidence threshold or batch job
that approves a card on its own.

Approving triggers an export attempt over AnkiConnect immediately, so
approve and export are the same reviewer decision. Export, in order:

1. A collection-wide duplicate search (no deck restriction) for the card's
   own text. A hit blocks the write and reports what it matched; nothing is
   written on a duplicate.
2. `addNote`, to the deck named in Settings (`All::2 Default::Wiki` by
   default), using the existing `Cloze` model for a card with cloze markup
   or `Basic` otherwise, tagged `wiki::<page-slug>`. No new note type is
   ever created.
3. The draft is marked `exported` in the inbox, and the seed is written
   back to the source page: a bullet in that page's `## Flashcard Seeds`
   section and an update to its `cards:` frontmatter (`deck`, `count`,
   `note_ids`). A source page that does not exist is created first with a
   minimal frontmatter, so a seed is never orphaned.

Anki being closed, or AnkiConnect being unreachable at all, is caught as
one case: a Notice explains it, and the draft is left `approved`, pending
export, rather than lost or silently retried. Running "Open review queue"
and approving again later, or a future bulk export over every `approved`
draft, is how it resolves; nothing retries in the background.

Every approve, edit-then-approve, and discard is appended, one line per
entry, to the disposition log (`loopback-disposition-log.md` by default),
with the prompt version, the model id, and a timestamp. This file is
append-only and plain text, so the owner can open and read it directly.

## Settings

- **Inbox file path.** Vault-relative path to the file captures are
  appended to. Defaults to `flashcard-inbox.md` at the vault root.
- **API key source.** Where drafting reads the model API key from: an
  environment variable, the OS keychain, or a value stored in the vault.
  Defaults to the environment variable. This vault syncs through iCloud, so
  a key stored in the vault, whether in `data.json` or in a note, is
  replicated in plaintext to every device and into every backup of the
  vault. The in-vault option carries this warning in the settings tab
  itself and exists for completeness, not as the recommended choice.
- **Drafting provider.** Anthropic or OpenAI-compatible. Selects which
  adapter the "Draft pending captures" command calls.
- **Model id.** The model id sent to whichever provider is selected, for
  example `claude-sonnet-4-5` or an OpenRouter model slug.
- **API key environment variable.** The variable name checked first,
  regardless of the API key source above.
- **OpenAI-compatible base URL.** Used only when the drafting provider is
  OpenAI-compatible.
- **In-vault API key.** Used only when the API key source above is set to
  vault. Left blank by default for the reason given above.
- **AnkiConnect URL.** The address the export step calls. Defaults to
  `http://localhost:8765`, the AnkiConnect default. Not used by capture or
  drafting.
- **Export deck.** The Anki deck an approved draft exports to. Defaults to
  `All::2 Default::Wiki`. Export refuses outright if this is set to a deck
  name starting with `#`, since those are filtered utility decks Anki
  rebuilds.
- **Disposition log path.** Vault-relative path to the append-only log of
  every approve, edit-then-approve, and discard. Defaults to
  `loopback-disposition-log.md` at the vault root.

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

Bundles each module under test to CommonJS with esbuild and runs every
`test/*.test.cjs` file with Node's built-in test runner. This covers:

- `capture-format.test.cjs`: the round-trip test for the capture block,
  a single capture, a multi-line quote with an internal blank line, two
  captures appended to the same file, and id uniqueness across repeated
  calls.
- `keys.test.cjs`: key resolution order, and that no error path ever
  surfaces a key value. Every fixture is an obviously fake placeholder;
  none of these tests touches a real environment variable, a real
  keychain entry, or the network.
- `linter.test.cjs`: one hand-written card per failure class the linter
  exists to catch, plus one well-formed card that passes clean.
- `passage-splitter.test.cjs`: a short passage left whole, an oversized
  passage split along paragraph breaks, and a single oversized paragraph
  split along sentence breaks.
- `draft-format.test.cjs` and `draft-format-block.test.cjs`: the round-trip
  test for the draft block, and finding and replacing one draft block by id
  without disturbing the blocks before or after it.
- `review-actions.test.cjs`: approve, edit then approve, and discard, each
  producing the right status change and the right disposition log entry,
  plus their bulk forms.
- `review-queue.test.cjs`: grouping drafts by the capture they came from,
  the 30-day stale split, orphan drafts, and the 50-pending-draft ceiling.
- `disposition-log.test.cjs`: the log line format round-trips, and
  appending never merges two entries onto the same line.
- `anki-note.test.cjs`: Cloze versus Basic model detection, field names,
  the `wiki::<page-slug>` tag, and the duplicate search query.
- `anki-client.test.cjs`: every AnkiConnect action, against an injected
  fake fetch, including the error and unreachable-network cases.
- `seed-writeback.test.cjs`: appending a Flashcard Seeds bullet with and
  without an existing section, and updating the `cards:` frontmatter block.

No test in this repository makes a network call or uses a real API key.

## Installing into a vault

This repository does not install itself into any vault. To try it, copy
`manifest.json`, `main.js`, and (if present) `styles.css` into
`<vault>/.obsidian/plugins/loopback/` after running `npm run build`, then
enable it from Community Plugins, Installed Plugins in Obsidian. Installing
the plugin into a specific vault is a decision for whoever owns that vault,
not something this repository does on its own.

## License

MIT. See `LICENSE`.

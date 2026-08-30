/*
The capture decision: turning a selection, its source path, and the lines
around it into the record capture-format.ts serializes. No dependency on
the Obsidian API, so it is unit tested directly rather than by bundling all
of main.ts and stubbing Editor, MarkdownView, and the rest of Obsidian's
surface the way the TCK-036 worker had to. LoopbackPlugin.captureSelection
in main.ts calls buildCaptureRecord after doing its own editor reads; this
module never touches an editor, a file, or the vault.

Nothing here changes what a capture looks like on disk. The record shape
and serialization stay owned by capture-format.ts, whose TCK-052
format-contract tests this module must not disturb.
*/

import { generateCaptureId, type Capture } from "./capture-format";

const HEADING_PATTERN = /^#{1,6}\s+.+/;

export interface CaptureRecordInput {
	/** The editor selection, already known to be non-blank; main.ts still shows its own Notice and never calls this on an empty selection. */
	selectionText: string;
	/** Vault-relative path the passage was captured from, or "unknown" when the view has no backing file. */
	sourcePath: string;
	/** Every line of the active file up through cursorLine, 0-indexed, in file order. Lines past cursorLine are never read, the same as resolveLocation's original upward-only search. */
	lines: string[];
	/** The 0-indexed line the selection starts on, from editor.getCursor("from"). */
	cursorLine: number;
	/** Injectable for tests, so a test never depends on the real clock. */
	now?: Date;
}

/**
 * The nearest heading at or above cursorLine, text only, or a 1-indexed
 * line number when there is none. Ported unchanged from
 * LoopbackPlugin.resolveLocation, which read the same way through
 * editor.getLine; here it reads from an array instead.
 */
export function resolveCaptureLocation(lines: string[], cursorLine: number): string {
	for (let line = cursorLine; line >= 0; line--) {
		const text = lines[line] ?? "";
		if (HEADING_PATTERN.test(text)) {
			return text.replace(/^#{1,6}\s+/, "");
		}
	}
	return `line ${cursorLine + 1}`;
}

/** Build the capture record for a non-empty selection. Pure: same input, same output, no I/O. */
export function buildCaptureRecord(input: CaptureRecordInput): Capture {
	const now = input.now ?? new Date();
	return {
		id: generateCaptureId(now),
		status: "captured",
		captured: now.toISOString(),
		source: input.sourcePath,
		location: resolveCaptureLocation(input.lines, input.cursorLine),
		quote: input.selectionText,
	};
}

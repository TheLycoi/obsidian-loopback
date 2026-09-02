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

/**
 * What to do when the reader drags across a passage with highlighter mode
 * on. TCK-082.
 *
 * Two rules, and the second one is the reader's own: mark the passage so it
 * is visibly highlighted from then on, unless it is highlighted already, in
 * which case leave the text alone and capture it as it stands. Re-dragging
 * over a passage you already marked must not turn "==text==" into
 * "====text====", which renders as literal equals signs rather than a
 * highlight.
 *
 * Obsidian's own "==" syntax is used rather than a Loopback-specific
 * marker. It renders as a highlight natively in both reading and live
 * preview, it survives in plain Markdown when this plugin is uninstalled,
 * and it is what a reader would have typed by hand.
 *
 * Pure, so the marking rule is proven without an editor, a document, or
 * Obsidian.
 */
export interface HighlightMarking {
	/** Replacement text for the selection, or undefined when it is already marked and must be left exactly as it is. */
	replacement: string | undefined;
	/** The passage to capture, always free of marker syntax so a card is never built around "==". */
	quote: string;
	alreadyMarked: boolean;
}

const HIGHLIGHT_MARKER = "==";

export function markSelectionAsHighlight(selectedText: string): HighlightMarking {
	const trimmed = selectedText.trim();
	if (trimmed.length === 0) {
		return { replacement: undefined, quote: "", alreadyMarked: false };
	}

	const wrapped =
		trimmed.length > HIGHLIGHT_MARKER.length * 2 &&
		trimmed.startsWith(HIGHLIGHT_MARKER) &&
		trimmed.endsWith(HIGHLIGHT_MARKER);

	if (wrapped) {
		return {
			replacement: undefined,
			quote: trimmed.slice(HIGHLIGHT_MARKER.length, -HIGHLIGHT_MARKER.length).trim(),
			alreadyMarked: true,
		};
	}

	return { replacement: `${HIGHLIGHT_MARKER}${trimmed}${HIGHLIGHT_MARKER}`, quote: trimmed, alreadyMarked: false };
}

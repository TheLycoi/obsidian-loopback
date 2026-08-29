/*
The disposition log: one line per draft a human has acted on, appended and
never rewritten. The design note calls this out by name: disposition is
logged for every draft, approved clean, edited then approved, or discarded,
with the prompt version and a timestamp, because it costs nothing to write
and cannot be reconstructed later. It is also the only evidence that would
ever justify tuning the prompt.

The format is plain text, one entry per line, so the owner can open the log
file directly and read it without tooling. This module only formats and
parses lines and appends them to a string; the file it is written to (a
vault-relative path from Settings) is Obsidian's job, not this module's.
*/

import type { DispositionLogEntry } from "./review-actions";

const FIELD_SEPARATOR = " | ";

/** One disposition entry, rendered as a single line with no trailing newline. */
export function formatLogLine(entry: DispositionLogEntry): string {
	return [
		entry.timestamp,
		`disposition: ${entry.disposition}`,
		`draft: ${entry.draftId}`,
		`capture: ${entry.captureId}`,
		`prompt: ${entry.promptVersion}`,
		`model: ${entry.modelId}`,
	].join(FIELD_SEPARATOR);
}

/** Parse one line back into an entry. Returns undefined for a blank line or one that does not match the format, rather than throwing, since a hand-edited log is expected to survive a stray edit. */
export function parseLogLine(line: string): DispositionLogEntry | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	const parts = trimmed.split(FIELD_SEPARATOR);
	if (parts.length !== 6) return undefined;
	const [timestamp, dispositionField, draftField, captureField, promptField, modelField] = parts;
	const disposition = dispositionField.replace(/^disposition: /, "");
	if (disposition !== "approved-clean" && disposition !== "approved-edited" && disposition !== "discarded") {
		return undefined;
	}
	return {
		timestamp,
		disposition,
		draftId: draftField.replace(/^draft: /, ""),
		captureId: captureField.replace(/^capture: /, ""),
		promptVersion: promptField.replace(/^prompt: /, ""),
		modelId: modelField.replace(/^model: /, ""),
	};
}

/** Append one entry to the end of the log's current text. Adds a newline before the new line only when the existing text does not already end in one, so repeated appends never merge two entries onto the same line. */
export function appendLogEntry(logContent: string, entry: DispositionLogEntry): string {
	const line = formatLogLine(entry);
	if (logContent.length === 0) return line + "\n";
	const separator = logContent.endsWith("\n") ? "" : "\n";
	return logContent + separator + line + "\n";
}

/** Append every entry in order. Used after a bulk approve or bulk discard, which produce more than one entry in one action. */
export function appendLogEntries(logContent: string, entries: DispositionLogEntry[]): string {
	let content = logContent;
	for (const entry of entries) {
		content = appendLogEntry(content, entry);
	}
	return content;
}

/*
The capture block format: read and write for flashcard-inbox.md.

This module has no dependency on the Obsidian API. It is pure text in, pure
text out, so it can be unit tested with plain Node and reused unchanged by
the drafting tool (a later ticket) that reads the same file.

The format is documented in README.md. Keep the two in sync: the README is
the contract other tools parse against, this file is one implementation of
that contract, not the other way around.

TCK-072 extends the format with one optional attribute, page, for a
raw-source capture highlighted in a PDF under sources/ rather than a
Markdown note. Everything else about the block, including a Markdown-note
capture's exact output, is unchanged: page is emitted only when present and
parsed back only when the attribute line was there, so an existing capture
round-trips byte-identical to before.
*/

export interface Capture {
	id: string;
	status: string;
	captured: string;
	source: string;
	location: string;
	quote: string;
	/**
	 * The 1-indexed page a passage was highlighted on, present only for a
	 * raw-source capture: one whose source path sits under sources/, the
	 * immutable raw collection, rather than a Markdown note. Absent entirely
	 * for a Markdown-note capture, not written as an empty or zero value, for
	 * the same reason modelId and promptVersion stay off a fresh capture: a
	 * field a block cannot fill in honestly is left out.
	 */
	page?: number;
}

/** Fields a fresh capture always has. Later tickets add modelId and promptVersion; those keys are absent here, not empty strings. */
export type NewCapture = Capture;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A stable id: a sortable timestamp plus a short random suffix so two captures in the same millisecond still differ. */
export function generateCaptureId(date: Date = new Date()): string {
	const stamp = date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.(\d+)Z$/, "$1");
	let suffix = "";
	for (let i = 0; i < 6; i++) {
		suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
	}
	return `${stamp}-${suffix}`;
}

function serializeQuote(quote: string): string {
	return quote
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

function deserializeQuote(block: string): string {
	return block
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => (line === ">" ? "" : line.replace(/^> ?/, "")))
		.join("\n");
}

/** Turn one capture into the Markdown block appended to the inbox file. */
export function serializeCapture(capture: Capture): string {
	const lines = [
		`## Capture ${capture.id}`,
		"",
		`- id: ${capture.id}`,
		`- status: ${capture.status}`,
		`- captured: ${capture.captured}`,
		`- source: ${capture.source}`,
		...(capture.page !== undefined ? [`- page: ${capture.page}`] : []),
		`- location: ${capture.location}`,
		"",
		serializeQuote(capture.quote),
		"",
		"---",
		"",
	];
	return lines.join("\n");
}

const BLOCK_PATTERN = /## Capture (\S+)\n\n((?:- .+\n)+)\n((?:>.*\n?)*)/g;

function parseAttributes(block: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const line of block.split("\n")) {
		if (!line.startsWith("- ")) continue;
		const rest = line.slice(2);
		const separator = rest.indexOf(": ");
		if (separator === -1) continue;
		const key = rest.slice(0, separator);
		const value = rest.slice(separator + 2);
		attributes[key] = value;
	}
	return attributes;
}

/** Read every capture block out of an inbox file's contents, in file order. */
export function parseCaptures(fileContent: string): Capture[] {
	const captures: Capture[] = [];
	const normalized = fileContent.replace(/\r\n/g, "\n");
	const pattern = new RegExp(BLOCK_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(normalized)) !== null) {
		const headingId = match[1];
		const attributes = parseAttributes(match[2]);
		const quote = deserializeQuote(match[3]);
		const capture: Capture = {
			id: attributes.id ?? headingId,
			status: attributes.status ?? "",
			captured: attributes.captured ?? "",
			source: attributes.source ?? "",
			location: attributes.location ?? "",
			quote,
		};
		// Only set when the attribute line was actually present, so a
		// Markdown-note capture parses back with no page key at all rather
		// than page: undefined, matching what serializeCapture wrote.
		if (attributes.page !== undefined) {
			capture.page = Number(attributes.page);
		}
		captures.push(capture);
	}
	return captures;
}

/**
 * True for a capture whose source sits under sources/, the immutable raw
 * collection decision 14 of the design note describes, rather than a
 * Markdown note anywhere else in the vault. A raw-source capture has no
 * digest page behind it by construction, which is what the review queue
 * uses this for: it cannot resolve a wiki::<page-slug> tag to a page and
 * cannot be reformulated the way a page-backed card can.
 */
export function isRawSourceCapture(capture: Pick<Capture, "source">): boolean {
	return capture.source.startsWith("sources/");
}

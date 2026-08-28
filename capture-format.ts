/*
The capture block format: read and write for flashcard-inbox.md.

This module has no dependency on the Obsidian API. It is pure text in, pure
text out, so it can be unit tested with plain Node and reused unchanged by
the drafting tool (a later ticket) that reads the same file.

The format is documented in README.md. Keep the two in sync: the README is
the contract other tools parse against, this file is one implementation of
that contract, not the other way around.
*/

export interface Capture {
	id: string;
	status: string;
	captured: string;
	source: string;
	location: string;
	quote: string;
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
		captures.push({
			id: attributes.id ?? headingId,
			status: attributes.status ?? "",
			captured: attributes.captured ?? "",
			source: attributes.source ?? "",
			location: attributes.location ?? "",
			quote,
		});
	}
	return captures;
}

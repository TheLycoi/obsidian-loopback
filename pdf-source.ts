/*
Raw-source capture: turning a PDF under sources/ into capture blocks the
same inbox and the same draft, lint, and review pipeline already handle.
This is TCK-072's stage 1, the Janus "Upload" stage adapted to a vault that
already splits raw material (sources/) from compiled pages (wiki/sources/),
per decision 14 of the design note.

Like capture-format.ts and drafting.ts, this module has no dependency on
the Obsidian API. Extraction takes bytes in and pages out; the two capture
builders take a selection or a set of model-proposed spans and return plain
Capture objects, so all of it can be unit tested with plain Node against a
real PDF and, for automatic mode, a fake adapter.

Order of work, and why: manual mode (buildRawSourceCapture) makes no model
call and no file I/O of its own. It is pure and synchronous, which is what
lets it work with no API key and during an outage, exactly like
captureSelection in main.ts. Automatic mode (proposeRawSourceCaptures) sits
on top of it and does call a model, through the narrow HighlightAdapter
interface below, kept separate from DraftAdapter in adapter.ts because a
proposed span is a passage to capture, not yet a candidate card: it still
has to pass through drafting, the linter, and a human before anything
reaches Anki.
*/

import { PDFParse } from "pdf-parse";
import { generateCaptureId, type Capture } from "./capture-format";

/** One page of extracted text, 1-indexed to match how a person cites a page. */
export interface PdfPage {
	number: number;
	text: string;
}

/**
 * Extract every page of a PDF as text, page numbers preserved. Provenance
 * without a page number cannot reopen a passage in a 40-page paper, so this
 * always returns one entry per page rather than one concatenated string.
 * Uses pdf-parse (the actively maintained 2.x line, a thin TypeScript
 * wrapper over Mozilla's own pdfjs-dist), chosen over hand-rolling a PDF
 * parser or using pdfjs-dist directly because pdf-parse already exposes
 * per-page text as its own first-class result shape (PageTextResult, one
 * `num` and `text` per page) rather than requiring a custom render callback.
 */
export async function extractPdfPages(data: Uint8Array): Promise<PdfPage[]> {
	const parser = new PDFParse({ data });
	try {
		const result = await parser.getText();
		return result.pages.map((page) => ({ number: page.num, text: page.text }));
	} finally {
		await parser.destroy();
	}
}

function normalizeForComparison(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a quote appears, verbatim enough to be checkable, on a page's
 * extracted text. Whitespace is collapsed before comparing, since a PDF's
 * text layer commonly breaks a sentence across lines or columns in ways
 * that do not match how a person would retype the same sentence; anything
 * beyond whitespace has to match exactly, since the grounding rule this
 * checks for is that the atom is present in the passage it came from, not
 * a paraphrase of it.
 */
export function quoteAppearsOnPage(pageText: string, quote: string): boolean {
	if (quote.trim().length === 0) return false;
	return normalizeForComparison(pageText).includes(normalizeForComparison(quote));
}

export interface RawSourceSelection {
	/** Vault-relative path. Must sit under sources/, the immutable raw collection; anything else belongs to the existing Markdown capture path. */
	sourcePath: string;
	/** 1-indexed page the passage was highlighted on. */
	page: number;
	/** The exact quoted passage. */
	quote: string;
}

/** Thrown by buildRawSourceCapture for a selection that cannot become a raw-source capture: a source outside sources/, a non-positive page, or an empty quote. */
export class RawSourceSelectionError extends Error {}

/**
 * Build a raw-source capture from a human's selection: a file, a page, and
 * a passage. Pure and synchronous, with no model call, no network call, and
 * no file I/O of its own, so this is the part of the pipeline that works
 * with no API key and during an outage. The caller is responsible for
 * appending the serialized block to the inbox, exactly as main.ts's
 * captureSelection does for a Markdown-note capture.
 */
export function buildRawSourceCapture(selection: RawSourceSelection, now: Date = new Date()): Capture {
	const { sourcePath, page, quote } = selection;
	if (!sourcePath.startsWith("sources/")) {
		throw new RawSourceSelectionError(
			`Loopback: "${sourcePath}" is not under sources/, so it cannot be captured as a raw source.`
		);
	}
	if (!Number.isInteger(page) || page < 1) {
		throw new RawSourceSelectionError(`Loopback: page must be a positive integer, got ${page}.`);
	}
	if (quote.trim().length === 0) {
		throw new RawSourceSelectionError("Loopback: nothing selected, nothing captured.");
	}
	return {
		id: generateCaptureId(now),
		status: "captured",
		captured: now.toISOString(),
		source: sourcePath,
		location: `page ${page}`,
		quote,
		page,
	};
}

export interface GroundedCapture {
	capture: Capture;
	/**
	 * Whether the quote was found, verbatim enough, on the extracted text of
	 * the page it names. False does not block the capture, since a PDF's
	 * text layer can legitimately fail to match a hand-typed passage (a
	 * ligature, a hyphenation break, a column reflow), but it does mean the
	 * grounding this format promises is unconfirmed, and a caller (a command
	 * in main.ts, a later ticket) should say so rather than claim it silently.
	 */
	grounded: boolean;
}

/** buildRawSourceCapture, plus a grounding check against the page text extractPdfPages already produced, so a caller can warn when a selection cannot be confirmed against the document it claims to come from. */
export function buildGroundedRawSourceCapture(
	selection: RawSourceSelection,
	pages: PdfPage[],
	now: Date = new Date()
): GroundedCapture {
	const capture = buildRawSourceCapture(selection, now);
	const pageText = pages.find((page) => page.number === selection.page)?.text ?? "";
	return { capture, grounded: quoteAppearsOnPage(pageText, selection.quote) };
}

/**
 * A selection as Obsidian's own PDF viewer hands it over: the text the
 * reader dragged across, the raw data-page-number attribute from the page
 * element the selection starts in, and the vault path of the open file.
 *
 * The page arrives as a string because that is what a DOM attribute is.
 * Parsing it here rather than at the call site is the point: it keeps the
 * whole conversion testable without a DOM, a PDF, or Obsidian, which is the
 * same separation buildRawSourceCapture already uses.
 */
export interface PdfViewerSelection {
	selectedText: string;
	/** Value of data-page-number on the nearest ancestor page element, or null when the walk up the DOM found none. */
	pageAttribute: string | null;
	sourcePath: string;
}

/**
 * Turn a viewer selection into the same RawSourceSelection the typed-in
 * path produces, so everything downstream is untouched by where the
 * selection came from.
 *
 * The quote is trimmed and nothing else. It is deliberately not
 * whitespace-normalized here: pdf.js breaks a selection across text spans
 * and lines, and quoteAppearsOnPage already collapses whitespace on both
 * sides when it checks grounding. Rewriting the quote to look tidier would
 * store something the reader did not select, which is exactly the grounding
 * rule this pipeline exists to keep.
 */
export function buildSelectionFromPdfViewer(selection: PdfViewerSelection): RawSourceSelection {
	const quote = selection.selectedText.trim();
	if (quote.length === 0) {
		throw new RawSourceSelectionError("Loopback: nothing selected in the PDF, nothing captured.");
	}
	if (selection.pageAttribute === null) {
		throw new RawSourceSelectionError(
			"Loopback: could not tell which page that selection is on. Select text inside a rendered page and try again."
		);
	}
	const page = Number(selection.pageAttribute);
	if (!Number.isInteger(page) || page < 1) {
		throw new RawSourceSelectionError(
			`Loopback: the viewer reported page "${selection.pageAttribute}", which is not a page number.`
		);
	}
	return { sourcePath: selection.sourcePath, page, quote };
}

/** One span a model proposes for capture: a page and the passage on it, nothing else. Not a candidate card; see the module comment. */
export interface SpanProposal {
	page: number;
	quote: string;
}

/**
 * The narrow interface automatic highlight mode calls through. Deliberately
 * not DraftAdapter from adapter.ts: DraftAdapter turns one passage already
 * captured into candidate cards, while this turns a whole document into
 * candidate passages, before any capture exists. Confusing the two would
 * let a "draft" skip the capture stage's provenance and grounding checks.
 * No implementation of this interface ships in this ticket; only a fake
 * one, in this module's tests, proves the orchestration below is correct.
 * Wiring a real provider behind it is left for a later ticket.
 */
export interface HighlightAdapter {
	proposeSpans(pages: PdfPage[], prompt?: string): Promise<SpanProposal[]>;
}

export interface AutomaticHighlightResult {
	/** One capture per proposed span that was grounded and well-formed. */
	captures: Capture[];
	/** Every proposed span that failed grounding or validation, kept rather than dropped, since a silently discarded proposal teaches nothing about the prompt. */
	rejected: SpanProposal[];
}

/**
 * Turn a document's pages into raw-source captures by asking adapter to
 * propose spans, then keeping only the ones grounded in the page they claim
 * to come from. This is the mechanical half of the grounding rule decision
 * 14 restates: the model analyses, it does not synthesise, and a span this
 * function cannot verify against the document's own text is rejected here,
 * before it ever becomes a capture, rather than trusted on the model's say.
 *
 * Every capture returned still has status "captured," identical to a manual
 * highlight or a Markdown-note selection: it goes through the same draft,
 * lint, and review path as anything else in the inbox, and reaches Anki
 * only if a human approves the card drafted from it. Nothing here skips the
 * human gate.
 */
export async function proposeRawSourceCaptures(
	sourcePath: string,
	pages: PdfPage[],
	adapter: HighlightAdapter,
	prompt?: string,
	now: Date = new Date()
): Promise<AutomaticHighlightResult> {
	const proposals = await adapter.proposeSpans(pages, prompt);
	const captures: Capture[] = [];
	const rejected: SpanProposal[] = [];

	for (const proposal of proposals) {
		const pageText = pages.find((page) => page.number === proposal.page)?.text;
		if (pageText === undefined || !quoteAppearsOnPage(pageText, proposal.quote)) {
			rejected.push(proposal);
			continue;
		}
		try {
			captures.push(buildRawSourceCapture({ sourcePath, page: proposal.page, quote: proposal.quote }, now));
		} catch {
			rejected.push(proposal);
		}
	}

	return { captures, rejected };
}

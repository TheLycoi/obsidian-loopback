/*
The Obsidian-facing half of wiki context retrieval: reads the source page
and a small set of related concept or entity pages out of app.vault, then
hands the raw text to wiki-context.ts, which does the actual extraction and
capping with no dependency on Obsidian. This is the only file in the wiki
context path that touches the vault, matching the split between
capture-decision.ts (pure) and the editor reads in main.ts that feed it.

Both App and TFile are imported as types only, never as values, so this
file makes no runtime `require("obsidian")` call at all: esbuild erases an
`import type` unconditionally. That is what makes this module testable
against a plain fake app object, the same as wiki-context.ts, rather than
needing the Module._load stub export-flow.test.cjs uses for a file that
does construct real Obsidian classes like Notice and TFile.

A raw-source capture (its source under sources/, per isRawSourceCapture)
has no digest page behind it by construction, so this returns an empty
WikiContext without touching the vault at all rather than trying to read a
PDF as text. A source page that does not exist yet, or fails to read,
resolves the same way: empty, never thrown. Wiki context is advisory, so a
capture with nothing to draw on still drafts, just blind, the same as
before this ticket.
*/

import type { App, TFile } from "obsidian";
import { isRawSourceCapture, type Capture } from "./capture-format";
import {
	buildWikiContext,
	extractRelatedPagePaths,
	resolveWikiLinkPath,
	type RelatedPageText,
	type WikiContext,
} from "./wiki-context";

async function readPageIfExists(app: App, path: string): Promise<string | undefined> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return undefined;
	try {
		return await app.vault.read(file as TFile);
	} catch {
		return undefined;
	}
}

/**
 * Retrieve the wiki context for one capture: the source page's own text,
 * its existing seeds and cards, and up to a small set of related concept
 * or entity pages it links to.
 */
export async function retrieveWikiContext(app: App, capture: Pick<Capture, "source">): Promise<WikiContext> {
	if (isRawSourceCapture(capture)) return buildWikiContext({});

	const sourcePageText = await readPageIfExists(app, capture.source);
	if (sourcePageText === undefined) return buildWikiContext({});

	const relatedPaths = extractRelatedPagePaths(sourcePageText);
	const relatedPages: RelatedPageText[] = [];
	for (const linkPath of relatedPaths) {
		const text = await readPageIfExists(app, resolveWikiLinkPath(linkPath));
		if (text !== undefined) relatedPages.push({ path: linkPath, text });
	}

	return buildWikiContext({ sourcePageText, relatedPages });
}

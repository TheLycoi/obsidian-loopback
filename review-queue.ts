/*
Builds the review queue's model out of the inbox file's text: which drafts
are still pending a human decision, grouped by the capture (the source
passage) each one came from, and which of those groups are stale.

This module has no dependency on the Obsidian API or on the review view
itself. It takes text in and a clock, and returns a plain data structure the
view renders and the capture guard in main.ts checks before writing a new
capture. Decision 5 of the design note sets both numbers here: drafts older
than 30 days move to a stale section shown first, and a new capture is
refused once more than 50 drafts are pending. Neither number expires a
draft; both only change where or whether a new one can land.

TCK-072 adds one more flag per group, noPageBehind, true when the group's
capture is a raw-source capture with no digest page to trace back to. See
NO_PAGE_BEHIND_NOTICE below for what that costs and how it is surfaced.
*/

import { parseCaptures, isRawSourceCapture, type Capture } from "./capture-format";
import { parseDrafts, type DraftRecord } from "./draft-format";

/** A draft still waiting on a human: not yet approved, exported, or discarded. */
const PENDING_STATUSES = new Set(["draft", "flagged"]);

export const STALE_DAYS = 30;
export const MAX_PENDING_DRAFTS = 50;

const STALE_AGE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Shown beside a group whose capture has no digest page behind it: a
 * raw-source capture, per decision 14 of the design note. Such a card
 * cannot be reformulated when it leeches, since the backward direction
 * resolves wiki::<page-slug> to a page and there is none, so the review
 * queue has to make that cost visible rather than let the card blend in.
 * The fix, when one of these keeps failing, is to promote it: write the
 * digest page, re-derive the seed from the page, then retag. This ticket
 * only surfaces the gap; it does not build that promotion path.
 */
export const NO_PAGE_BEHIND_NOTICE =
	"No page behind this capture. It cannot be reformulated if it leeches; promote it by writing a digest page first.";

export interface QueueGroup {
	capture: Capture;
	drafts: DraftRecord[];
	stale: boolean;
	/** True when capture has no digest page behind it: a raw-source capture from sources/, tagged source::<file-slug> rather than wiki::<page-slug> on export. */
	noPageBehind: boolean;
}

export interface QueueModel {
	/** Groups whose capture is older than STALE_DAYS, shown first. */
	staleGroups: QueueGroup[];
	/** Every other group, in capture order. */
	freshGroups: QueueGroup[];
	/** Total pending drafts across every group, stale or not. */
	pendingCount: number;
	/** Draft ids with no capture block to match against. Reviewable, but with no source passage to show beside them. */
	orphanDrafts: DraftRecord[];
}

function isPending(draft: DraftRecord): boolean {
	return PENDING_STATUSES.has(draft.status);
}

function isStale(capture: Capture, now: Date): boolean {
	const capturedAt = new Date(capture.captured);
	if (Number.isNaN(capturedAt.getTime())) return false;
	return now.getTime() - capturedAt.getTime() > STALE_AGE_MS;
}

/** Read the inbox and build the queue a reviewer works from. */
export function buildQueue(fileContent: string, now: Date = new Date()): QueueModel {
	const captures = parseCaptures(fileContent);
	const drafts = parseDrafts(fileContent);
	const captureById = new Map(captures.map((capture) => [capture.id, capture]));

	const draftsByCapture = new Map<string, DraftRecord[]>();
	const orphanDrafts: DraftRecord[] = [];
	let pendingCount = 0;

	for (const draft of drafts) {
		if (!isPending(draft)) continue;
		pendingCount += 1;
		const capture = captureById.get(draft.captureId);
		if (!capture) {
			orphanDrafts.push(draft);
			continue;
		}
		const existing = draftsByCapture.get(draft.captureId);
		if (existing) {
			existing.push(draft);
		} else {
			draftsByCapture.set(draft.captureId, [draft]);
		}
	}

	const staleGroups: QueueGroup[] = [];
	const freshGroups: QueueGroup[] = [];

	for (const capture of captures) {
		const groupDrafts = draftsByCapture.get(capture.id);
		if (!groupDrafts || groupDrafts.length === 0) continue;
		const group: QueueGroup = {
			capture,
			drafts: groupDrafts,
			stale: isStale(capture, now),
			noPageBehind: isRawSourceCapture(capture),
		};
		(group.stale ? staleGroups : freshGroups).push(group);
	}

	return { staleGroups, freshGroups, pendingCount, orphanDrafts };
}

/**
 * Whether a new capture must be refused right now. Called before a capture
 * is written, never after, so a capture that would push the count past the
 * ceiling is the one that gets refused, and everything already pending
 * stays exactly where it is.
 */
export function shouldRefuseCapture(fileContent: string, now: Date = new Date()): boolean {
	return buildQueue(fileContent, now).pendingCount > MAX_PENDING_DRAFTS;
}

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

TCK-076 changes what counts as a group. Before, a capture with zero pending
drafts formed no group at all, whether that was because drafting had not
run yet or because every draft it ever had was already approved, exported,
or discarded. Those are different situations and the reviewer needs to see
one of them: a capture that has landed but has no draft yet is exactly the
"passage arrived, work is in flight" state the one-command capture-and-draft
path produces, and it must be visible immediately, before the model call
that drafts it even returns. A capture whose drafts are all resolved is
finished business and still forms no group. The two are told apart by
whether the capture has ever had any draft, pending or not, not by whether
it currently has a pending one.
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
	/** True when this capture has never had a draft, pending or otherwise, so the view has landed but drafting has not produced anything yet. The view renders this as a pending state, not as an empty group. */
	awaitingDraft: boolean;
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
	// Every draft ever written for a capture, pending or not, so a capture
	// whose drafts are all resolved (approved, exported, discarded) can be
	// told apart from one that has never had a draft at all. Only the latter
	// gets an awaitingDraft group.
	const everDraftedCaptureIds = new Set<string>();
	const orphanDrafts: DraftRecord[] = [];
	let pendingCount = 0;

	for (const draft of drafts) {
		everDraftedCaptureIds.add(draft.captureId);
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
		const groupDrafts = draftsByCapture.get(capture.id) ?? [];
		const everDrafted = everDraftedCaptureIds.has(capture.id);
		// A capture whose drafts are all resolved and pending none is finished
		// business: no group. A capture that has never had a draft at all is
		// the "just landed, drafting in flight" state and gets a group with an
		// empty drafts array, flagged awaitingDraft, so the reviewer sees it
		// the moment it arrives rather than only once a card exists.
		if (groupDrafts.length === 0 && everDrafted) continue;
		const group: QueueGroup = {
			capture,
			drafts: groupDrafts,
			stale: isStale(capture, now),
			noPageBehind: isRawSourceCapture(capture),
			awaitingDraft: groupDrafts.length === 0,
		};
		(group.stale ? staleGroups : freshGroups).push(group);
	}

	// Newest capture reachable without scrolling past older ones: the fresh
	// section lists most recently captured first. Stale groups keep capture
	// order, since that section is a triage list, not a landing area for new
	// work.
	freshGroups.reverse();

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

/**
 * Where the review panel should be opened, decided from the number of view
 * leaves that already exist and the configured side. Pure, so the rule that
 * matters most about the ribbon icon (TCK-079) can be proven without an
 * Obsidian workspace: clicking it while the panel is already open must
 * focus the panel that exists, never create a second one.
 *
 * TCK-076 settled the behavior this encodes and it does not change here. An
 * existing leaf wins outright and is revealed wherever the reviewer has
 * dragged it, because Obsidian persists that drag and resetting it on every
 * click would fight the reviewer. The configured side is consulted only in
 * the one case where there is no placement to respect yet, which is when a
 * leaf has to be created.
 *
 * Placement note, and it is a compromise rather than a design choice: this
 * belongs in its own module next to the view, not in the queue model. It
 * lives here because the test build is a single explicit esbuild command
 * per module in package.json, and package.json currently carries another
 * ticket's uncommitted work that this ticket must not touch. Move it out
 * when package.json is free.
 */
export type ReviewPanelTarget = { kind: "existing" } | { kind: "create"; side: "left" | "right" };

export function chooseReviewPanelTarget(existingLeafCount: number, side: "left" | "right"): ReviewPanelTarget {
	if (existingLeafCount > 0) return { kind: "existing" };
	return { kind: "create", side };
}

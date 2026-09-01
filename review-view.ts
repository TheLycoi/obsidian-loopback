/*
The review queue's view: one screen with every pending draft beside the
source passage it came from, stale drafts first, and one key to approve.
This file only renders and reacts to input. Every action it takes calls
straight into review-orchestrator.ts, which is where the inbox file, the
disposition log, and the AnkiConnect export actually happen; nothing here
talks to the vault or to Anki directly.

Approve is bound to both a button and the "a" key on a focused draft row,
discard to a button and "d," so a reviewer working down the list never has
to reach for the mouse. Bulk approve and bulk discard act on whatever is
checked. The 10-second-per-draft target from decision 6 is a layout goal,
not something this file measures: the row shows the card, the Back Extra,
any lint flag, and the source passage together, and nothing here forces a
click just to see one of them.

TCK-076 adds two things, both about closing the gap between a highlight and
a reviewable card. First, a group whose capture has not been drafted yet
(review-queue.ts flags this awaitingDraft) renders a pending line instead of
either an empty group or nothing at all: the reviewer sees the passage land
before any card exists. Second, this view no longer only refreshes itself
when the reviewer runs a command; it listens for the inbox file changing
underneath it, on "create" for the very first capture ever and "modify" for
every one after, and re-renders on its own. That listener does not care
which side of the workspace it lives on: everything here reads from
this.plugin.settings and this.app, never from leaf placement, so the same
behavior holds whether the leaf sits in the left sidebar, the right, or
wherever the reviewer has since dragged it.

A drafting failure is never persisted to the inbox file (the capture and
draft block formats are locked and this ticket does not touch them), so
draftErrors below is this view's own in-memory record of the most recent
failure per capture id, reported by the plugin after a drafting pass. It is
lost on reload, same as any other purely in-session UI state, but reachable
the whole time the failure is still relevant: until a later drafting pass
succeeds for that capture, at which point the group renders real drafts and
the stored error is cleared as stale.
*/

import { ItemView, Notice, normalizePath, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type { DraftRecord } from "./draft-format";
import {
	loadQueue,
	performApprove,
	performBulkApprove,
	performBulkDiscard,
	performDiscard,
	performEditAndApprove,
} from "./review-orchestrator";
import { NO_PAGE_BEHIND_NOTICE, STALE_DAYS, type QueueGroup } from "./review-queue";
import type LoopbackPlugin from "./main";

export const VIEW_TYPE_REVIEW_QUEUE = "loopback-review-queue";

export class ReviewQueueView extends ItemView {
	private readonly plugin: LoopbackPlugin;
	private readonly selected: Set<string> = new Set();
	/** Most recent drafting failure per capture id, reported by the plugin. Session-only; see the file header for why this cannot live on disk. */
	private readonly draftErrors: Map<string, string> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: LoopbackPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_REVIEW_QUEUE;
	}

	getDisplayText(): string {
		return "Loopback review queue";
	}

	getIcon(): string {
		return "inbox";
	}

	async onOpen(): Promise<void> {
		const onInboxChange = (file: TAbstractFile) => {
			if (file.path === normalizePath(this.plugin.settings.inboxPath)) {
				void this.refresh();
			}
		};
		// "create" covers the very first capture ever, when the inbox file did
		// not exist and appendToInbox had to create it. Every capture and every
		// drafting pass after that appends or modifies, which fires "modify"
		// instead. Both have to be watched or the first capture in a vault
		// would land silently until something else happened to trigger a
		// render.
		this.registerEvent(this.app.vault.on("create", onInboxChange));
		this.registerEvent(this.app.vault.on("modify", onInboxChange));
		await this.render();
	}

	/** Report a drafting failure for one capture so the reviewer sees it here, not only as a transient Notice. Safe to call whether or not this view is currently visible. */
	reportDraftError(captureId: string, message: string): void {
		this.draftErrors.set(captureId, message);
		void this.refresh();
	}

	async refresh(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("loopback-review-queue");

		const queue = await loadQueue(this.app, this.plugin.settings);

		const header = container.createDiv({ cls: "loopback-review-header" });
		header.createEl("h3", { text: `Loopback review queue, ${queue.pendingCount} pending` });
		const bulkRow = header.createDiv({ cls: "loopback-bulk-row" });
		bulkRow.createEl("button", { text: "Approve selected" }).onclick = () => void this.runBulk("approve");
		bulkRow.createEl("button", { text: "Discard selected" }).onclick = () => void this.runBulk("discard");

		// pendingCount only counts drafts, so a capture that has landed but has
		// no draft yet (awaitingDraft) would not register here even though it
		// has its own group to show. The empty-state message is only correct
		// when there is truly nothing at all: no pending draft, no capture
		// still waiting on one, and no orphan.
		const hasAnything =
			queue.pendingCount > 0 || queue.staleGroups.length > 0 || queue.freshGroups.length > 0 || queue.orphanDrafts.length > 0;
		if (!hasAnything) {
			container.createEl("p", { text: "Nothing pending review." });
			return;
		}

		if (queue.staleGroups.length > 0) {
			container.createEl("h4", { text: `Stale, older than ${STALE_DAYS} days` });
			for (const group of queue.staleGroups) this.renderGroup(container, group);
		}

		if (queue.freshGroups.length > 0) {
			if (queue.staleGroups.length > 0) container.createEl("h4", { text: "Recent" });
			for (const group of queue.freshGroups) this.renderGroup(container, group);
		}

		if (queue.orphanDrafts.length > 0) {
			container.createEl("h4", { text: "Orphan drafts, no matching capture found" });
			const list = container.createDiv({ cls: "loopback-orphan-list" });
			for (const draft of queue.orphanDrafts) this.renderDraftRow(list, draft);
		}
	}

	private renderGroup(container: HTMLElement, group: QueueGroup): void {
		const groupEl = container.createDiv({ cls: "loopback-group" });
		const passageEl = groupEl.createDiv({ cls: "loopback-passage" });
		passageEl.createDiv({
			cls: "loopback-passage-meta",
			text: `${group.capture.source} - ${group.capture.location}`,
		});
		passageEl.createEl("blockquote", { text: group.capture.quote });
		// TCK-072 flagged noPageBehind on the queue model; TCK-073 is what
		// actually renders it, since a reviewer cannot act on a flag they
		// cannot see. A raw-source capture group gets this notice instead of
		// blending in with a page-backed one.
		if (group.noPageBehind) {
			passageEl.createDiv({ cls: "loopback-no-page-behind", text: NO_PAGE_BEHIND_NOTICE });
		}

		if (group.drafts.length > 0) {
			// A draft exists for this capture now, so any earlier failure no
			// longer describes the current state. Drop it rather than let a
			// stale error sit next to a card that already drafted fine.
			this.draftErrors.delete(group.capture.id);
		} else {
			const failure = this.draftErrors.get(group.capture.id);
			if (failure) {
				passageEl.createDiv({ cls: "loopback-draft-failed", text: `Drafting failed: ${failure}` });
			} else if (group.awaitingDraft) {
				passageEl.createDiv({ cls: "loopback-draft-pending", text: "Drafting in progress..." });
			}
		}

		for (const draft of group.drafts) this.renderDraftRow(groupEl, draft);
	}

	private renderDraftRow(container: HTMLElement, draft: DraftRecord): void {
		const row = container.createDiv({ cls: "loopback-draft-row", attr: { tabindex: "0" } });
		row.dataset.draftId = draft.id;

		const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
		checkbox.onchange = () => {
			if (checkbox.checked) this.selected.add(draft.id);
			else this.selected.delete(draft.id);
		};

		const body = row.createDiv({ cls: "loopback-draft-body" });
		body.createDiv({ cls: "loopback-card-text", text: draft.cardText });
		body.createDiv({ cls: "loopback-back-extra", text: `Back: ${draft.backExtra}` });
		if (draft.status === "flagged" && draft.lintFailures.length > 0) {
			body.createDiv({ cls: "loopback-flag", text: `Flagged: ${draft.lintFailures.join(", ")}` });
		}

		const actions = row.createDiv({ cls: "loopback-actions" });
		actions.createEl("button", { text: "Approve (a)" }).onclick = () => void this.approve(draft.id);
		actions.createEl("button", { text: "Edit" }).onclick = () => this.startEdit(row, draft);
		actions.createEl("button", { text: "Discard (d)" }).onclick = () => void this.discard(draft.id);

		row.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.target !== row) return;
			if (event.key === "a" || event.key === "A") {
				event.preventDefault();
				void this.approve(draft.id);
			} else if (event.key === "d" || event.key === "D") {
				event.preventDefault();
				void this.discard(draft.id);
			}
		});
	}

	private startEdit(row: HTMLElement, draft: DraftRecord): void {
		row.empty();
		const cardTextArea = row.createEl("textarea", { cls: "loopback-edit-card" });
		cardTextArea.value = draft.cardText;
		const backExtraArea = row.createEl("textarea", { cls: "loopback-edit-back" });
		backExtraArea.value = draft.backExtra;
		const actions = row.createDiv({ cls: "loopback-actions" });
		actions.createEl("button", { text: "Save and approve" }).onclick = () =>
			void this.editAndApprove(draft.id, cardTextArea.value, backExtraArea.value);
		actions.createEl("button", { text: "Cancel" }).onclick = () => void this.refresh();
	}

	private async approve(draftId: string): Promise<void> {
		await performApprove(this.app, this.plugin.settings, draftId);
		await this.refresh();
	}

	private async editAndApprove(draftId: string, cardText: string, backExtra: string): Promise<void> {
		await performEditAndApprove(this.app, this.plugin.settings, draftId, { cardText, backExtra });
		await this.refresh();
	}

	private async discard(draftId: string): Promise<void> {
		await performDiscard(this.app, this.plugin.settings, draftId);
		await this.refresh();
	}

	private async runBulk(kind: "approve" | "discard"): Promise<void> {
		const ids = Array.from(this.selected);
		if (ids.length === 0) {
			new Notice("Loopback: check at least one draft first.");
			return;
		}
		if (kind === "approve") {
			await performBulkApprove(this.app, this.plugin.settings, ids);
		} else {
			await performBulkDiscard(this.app, this.plugin.settings, ids);
		}
		this.selected.clear();
		await this.refresh();
	}
}

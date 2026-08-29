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
*/

import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { DraftRecord } from "./draft-format";
import {
	loadQueue,
	performApprove,
	performBulkApprove,
	performBulkDiscard,
	performDiscard,
	performEditAndApprove,
} from "./review-orchestrator";
import { STALE_DAYS, type QueueGroup } from "./review-queue";
import type LoopbackPlugin from "./main";

export const VIEW_TYPE_REVIEW_QUEUE = "loopback-review-queue";

export class ReviewQueueView extends ItemView {
	private readonly plugin: LoopbackPlugin;
	private readonly selected: Set<string> = new Set();

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
		await this.render();
	}

	private async refresh(): Promise<void> {
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

		if (queue.pendingCount === 0) {
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

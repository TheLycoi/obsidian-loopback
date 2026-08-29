/*
Writes an exported card back to the vault page it came from: a bullet in
that page's `## Flashcard Seeds` section, per section 2 of CLAUDE.md and the
wiki schema's card layer, and an update to the page's `cards:` frontmatter
block (`deck`, `count`, `note_ids`), per the schema's optional cards
frontmatter section.

This module is pure text in, text out, exactly like draft-format.ts and
capture-format.ts, so it is unit tested with plain strings and no vault. The
Obsidian-facing export flow (a later module) reads and writes the actual
page file; this module only computes what the new content should be.

A seed written here always starts at status "carded," not "draft" or
"approved": by the time this function runs, the card already exists in
Anki, so recording it as anything earlier in the schema's own draft, then
approved, then carded progression would misstate where it is.
*/

export interface SeedInfo {
	cardText: string;
	backExtra: string;
}

export interface CardsFrontmatterUpdate {
	deck: string;
	noteId: number;
}

interface CardsBlock {
	deck: string;
	count: number;
	noteIds: number[];
}

const FLASHCARD_SEEDS_HEADING = "## Flashcard Seeds";

/** The bullet line this export adds to the page's Flashcard Seeds section. */
export function buildSeedBullet(seed: SeedInfo): string {
	return `- [carded] Cloze: ${seed.cardText} (Back: ${seed.backExtra})`;
}

/**
 * Append one seed bullet to the page's Flashcard Seeds section, creating
 * the section at the end of the page when it does not exist yet. When the
 * section exists, the bullet lands at the end of it, before whatever
 * heading (if any) follows, so later sections on the page are undisturbed.
 */
export function appendFlashcardSeed(pageContent: string, seed: SeedInfo): string {
	const bullet = buildSeedBullet(seed);
	const headingPattern = /^## Flashcard Seeds[ \t]*$/m;
	const match = headingPattern.exec(pageContent);

	if (!match) {
		const trimmed = pageContent.replace(/\s+$/, "");
		const prefix = trimmed.length > 0 ? trimmed + "\n\n" : "";
		return `${prefix}${FLASHCARD_SEEDS_HEADING}\n\n${bullet}\n`;
	}

	const sectionStart = match.index + match[0].length;
	const rest = pageContent.slice(sectionStart);
	const nextHeadingMatch = /\n(#{1,6}[ \t])/.exec(rest);

	if (!nextHeadingMatch) {
		const trimmedEnd = pageContent.replace(/\s+$/, "");
		return `${trimmedEnd}\n${bullet}\n`;
	}

	const insertAt = sectionStart + nextHeadingMatch.index + 1;
	const before = pageContent.slice(0, insertAt).replace(/\n*$/, "\n\n");
	const after = pageContent.slice(insertAt);
	return `${before}${bullet}\n\n${after}`;
}

function parseCardsBlock(bodyLines: string[], headingIndex: number): { block: CardsBlock; endIndex: number } {
	let deck = "";
	let count = 0;
	let noteIds: number[] = [];
	let index = headingIndex + 1;

	for (; index < bodyLines.length; index++) {
		const line = bodyLines[index];
		if (!/^\s+\S/.test(line)) break;

		const deckMatch = /^\s+deck:\s*(.+)$/.exec(line);
		if (deckMatch) {
			deck = deckMatch[1].trim();
			continue;
		}
		const countMatch = /^\s+count:\s*(\d+)\s*$/.exec(line);
		if (countMatch) {
			count = parseInt(countMatch[1], 10);
			continue;
		}
		const noteIdsMatch = /^\s+note_ids:\s*\[(.*)\]\s*$/.exec(line);
		if (noteIdsMatch) {
			noteIds = noteIdsMatch[1]
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
				.map((part) => parseInt(part, 10));
			continue;
		}
	}

	return { block: { deck, count, noteIds }, endIndex: index };
}

function serializeCardsBlock(block: CardsBlock): string[] {
	return [
		"cards:",
		`  deck: ${block.deck}`,
		`  count: ${block.count}`,
		`  note_ids: [${block.noteIds.join(", ")}]`,
	];
}

/**
 * Update, or create, the page's `cards:` frontmatter block. An existing
 * block has its count incremented by one and the new note id appended,
 * never overwritten, so a page carrying cards from more than one export
 * keeps every id. A page with no frontmatter at all gets a minimal one
 * added, rather than the write being skipped.
 */
export function updateCardsFrontmatter(pageContent: string, update: CardsFrontmatterUpdate): string {
	const frontmatterPattern = /^---\n([\s\S]*?)\n---\n?/;
	const match = frontmatterPattern.exec(pageContent);

	if (!match) {
		const block = serializeCardsBlock({ deck: update.deck, count: 1, noteIds: [update.noteId] });
		return `---\n${block.join("\n")}\n---\n\n${pageContent}`;
	}

	const bodyLines = match[1].length > 0 ? match[1].split("\n") : [];
	const cardsIndex = bodyLines.findIndex((line) => /^cards:\s*$/.test(line));

	let newBodyLines: string[];
	if (cardsIndex === -1) {
		const block = serializeCardsBlock({ deck: update.deck, count: 1, noteIds: [update.noteId] });
		newBodyLines = [...bodyLines, ...block];
	} else {
		const { block, endIndex } = parseCardsBlock(bodyLines, cardsIndex);
		const updatedBlock: CardsBlock = {
			deck: update.deck,
			count: block.count + 1,
			noteIds: [...block.noteIds, update.noteId],
		};
		newBodyLines = [...bodyLines.slice(0, cardsIndex), ...serializeCardsBlock(updatedBlock), ...bodyLines.slice(endIndex)];
	}

	const rest = pageContent.slice(match[0].length);
	return `---\n${newBodyLines.join("\n")}\n---\n${rest}`;
}

/**
 * A minimal source page, used only when a draft's capture points at a
 * vault path that does not exist, so the seed always lands on a real page
 * rather than being dropped as an orphan. Decision 4 in the design note
 * requires the source page to be created first when the passage came from
 * outside the vault; this is the smallest page that satisfies the source
 * page template in the wiki schema, left for the normal wiki pipeline to
 * flesh out later.
 */
export function buildMinimalSourcePage(title: string, createdDate: string): string {
	return ["---", "type: source", `created: ${createdDate}`, "---", "", `# ${title}`, ""].join("\n");
}

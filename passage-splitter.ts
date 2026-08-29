/*
Pre-call shape and length checks for a captured passage. A passage too long
for one clean drafting call is split into chunks along paragraph breaks
and, where a single paragraph alone is too long, sentence breaks, rather
than sent whole and left for the model to somehow keep straight.
*/

/**
 * Passages at or under this many words go to the model as one chunk. This
 * keeps a chunk inside one coherent idea; it is not tuned against any one
 * model's context window.
 */
export const MAX_PASSAGE_WORDS = 300;

function countWords(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\s+/).length;
}

/** True when a passage has no usable content: empty, or whitespace only. */
export function isEmptyPassage(passage: string): boolean {
	return passage.trim().length === 0;
}

function splitIntoSentences(paragraph: string): string[] {
	const sentences = paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
	return sentences ? sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0) : [paragraph];
}

function splitOversizedParagraph(paragraph: string, maxWords: number): string[] {
	const sentences = splitIntoSentences(paragraph);
	const chunks: string[] = [];
	let current: string[] = [];
	let currentWords = 0;

	for (const sentence of sentences) {
		const sentenceWords = countWords(sentence);
		if (currentWords > 0 && currentWords + sentenceWords > maxWords) {
			chunks.push(current.join(" "));
			current = [];
			currentWords = 0;
		}
		current.push(sentence);
		currentWords += sentenceWords;
	}
	if (current.length > 0) chunks.push(current.join(" "));
	return chunks;
}

/**
 * Split a passage into chunks no longer than maxWords, along paragraph
 * breaks first and sentence breaks when one paragraph alone is too long.
 * A passage already under the limit comes back as a single-element array.
 * An empty passage comes back as an empty array, since there is nothing to
 * send to a model.
 */
export function splitPassage(passage: string, maxWords: number = MAX_PASSAGE_WORDS): string[] {
	if (isEmptyPassage(passage)) return [];
	if (countWords(passage) <= maxWords) return [passage];

	const paragraphs = passage.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
	const chunks: string[] = [];
	let current: string[] = [];
	let currentWords = 0;

	for (const paragraph of paragraphs) {
		const paragraphWords = countWords(paragraph);

		if (paragraphWords > maxWords) {
			if (current.length > 0) {
				chunks.push(current.join("\n\n"));
				current = [];
				currentWords = 0;
			}
			chunks.push(...splitOversizedParagraph(paragraph, maxWords));
			continue;
		}

		if (currentWords > 0 && currentWords + paragraphWords > maxWords) {
			chunks.push(current.join("\n\n"));
			current = [];
			currentWords = 0;
		}
		current.push(paragraph);
		currentWords += paragraphWords;
	}
	if (current.length > 0) chunks.push(current.join("\n\n"));
	return chunks;
}

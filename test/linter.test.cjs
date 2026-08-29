/*
Tests for the deterministic linter in linter.ts. No model call, no network
call: every fixture here is hand-written, one card designed to isolate
exactly one of the six failure classes decision 12 names, plus one card
that should pass every check clean.

Run via `npm test`, which bundles linter.ts to CommonJS with esbuild first.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { lintDraft } = require("../.test-build/linter.cjs");

test("a well-formed card with a Back Extra that explains rather than restates passes clean", () => {
	const result = lintDraft({
		cardText:
			"Merkel discs are {{c1::slow}}-adapting mechanoreceptors that respond to {{c2::sustained pressure}}.",
		backExtra:
			"Slow adaptation means the discs keep firing for as long as the pressure is applied, which is what lets you feel a constant touch instead of it fading after a second.",
	});

	assert.equal(result.passed, true);
	assert.deepEqual(result.failures, []);
});

test("a card with five clozes fails on cloze count", () => {
	const result = lintDraft({
		cardText:
			"PEMDAS orders operations as {{c1::parentheses}}, {{c2::exponents}}, {{c3::multiplication}}, {{c4::division}}, {{c5::addition}}.",
		backExtra:
			"The acronym fixes evaluation order so two readers of the same expression land on the same answer, which is why calculators follow it too.",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("cloze-count"));
});

test("a card that skips from c1 to c3 fails on cloze numbering", () => {
	const result = lintDraft({
		cardText: "Sound intensity is measured in {{c1::decibels}}, a {{c3::logarithmic}} scale.",
		backExtra:
			"Each additional ten decibels represents a tenfold jump in intensity rather than a linear step, which is why the scale feels compressed at loud volumes.",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("cloze-numbering"));
});

test("a cloze spanning four clauses crams framing into the braces and fails", () => {
	const result = lintDraft({
		cardText:
			"Blood pressure regulation involves {{c1::a process that begins in the kidney, continues through hormonal signaling, and is ultimately controlled by the brain}} alongside {{c2::baroreceptor feedback}}.",
		backExtra:
			"Baroreceptors sense stretch in vessel walls and signal the brainstem within milliseconds, faster than the slower hormonal path, so short-term swings are corrected first.",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("framing-in-braces"));
});

test("a Back Extra that is the cloze answer verbatim fails as a substring restatement", () => {
	const result = lintDraft({
		cardText: "The mitochondria is the {{c1::powerhouse}} of the {{c2::cell}}.",
		backExtra: "powerhouse of the cell",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("back-extra-substring"));
});

test("a Back Extra that reorders the front's own words without adding a why fails as a near-restatement", () => {
	const result = lintDraft({
		cardText: "The mitochondria is the {{c1::powerhouse}} of the {{c2::cell}}.",
		backExtra: "Powerhouse mitochondria of the cell.",
	});

	assert.equal(result.passed, false);
	assert.deepEqual(result.failures, ["back-extra-near-restatement"]);
});

test("a card whose front and back together pass 80 words fails the length ceiling", () => {
	const result = lintDraft({
		cardText:
			"Working memory holds information for immediate cognitive use, with early estimates of about {{c1::seven}} chunks and later estimates of about {{c2::four}} chunks.",
		backExtra:
			"George Miller's 1956 paper proposed seven as a magical number covering many memory span studies of the era, but Nelson Cowan's 2001 review argued that once rehearsal and grouping strategies are controlled for, the underlying limit looks closer to four separate chunks held under strict attentional focus rather than a flexible buffer that years of practice or clever encoding tricks could ever stretch very far beyond that point.",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("length-ceiling"));
});

test("an empty Back Extra fails rather than passing by accident", () => {
	const result = lintDraft({
		cardText: "Corpuscles are {{c1::slow}}-adapting mechanoreceptors that respond to {{c2::sustained pressure}}.",
		backExtra: "",
	});

	assert.equal(result.passed, false);
	assert.ok(result.failures.includes("back-extra-substring"));
	assert.ok(result.failures.includes("back-extra-near-restatement"));
});

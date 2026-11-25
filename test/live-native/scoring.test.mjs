import assert from "node:assert/strict";
import test from "node:test";
import { extraBoundaryRepeats, previewProgress, scoreCheckpoint, scoreDraftTrace, wordErrors } from "./scoring.mjs";

const words = "one two three four five six seven eight nine ten eleven twelve".split(" ")
	.map((word, i) => ({ word, endMs: (i + 1) * 900 }));

test("timely growing correct prefixes and a perfect final do not rescue an unrelated visible tail", () => {
	const unrelated = "owl fish dog bee cat ant mole bat goat mink mouse";
	const ui = ["one two", "one two three", "one two three four"].map((prefix, i) => ({ t: 2_000 + i * 3_000, line: `Live: ${prefix} ${unrelated}` }));
	assert.equal(previewProgress(ui, words, 0, 9_000).firstCorrectMs, 2_000);
	const reference = words.map(({ word }) => word).join(" ");
	assert.equal(wordErrors(reference, reference).wer, 0);
	const relevance = scoreDraftTrace(ui, words, 0, 9_000);
	assert.deepEqual(relevance.checkpoints.map(({ pass, tailPrecision }) => [pass, tailPrecision]), [[false, 0], [false, 0], [false, 0]]);
	assert.equal(relevance.checkpoints[0].precision, 2 / 13);
	assert.equal(relevance.pass, false);
});

test("one corrected miss in five checkpoints passes; a replacement displayed later is never scored early", () => {
	const ui = [
		{ t: 4_000, line: "Live: one two three four" },
		{ t: 6_000, line: "Live: five rainbow bats" },
		{ t: 6_001, line: "Live: …four five six" },
		{ t: 9_000, line: "Live: …seven eight nine ten" },
		{ t: 11_000, line: "Live: …nine ten eleven twelve" },
	];
	const result = scoreDraftTrace(ui, words, 0, 13_000);
	assert.deepEqual(result.checkpoints.map(({ pass }) => pass), [true, false, true, true, true]);
	assert.equal(result.pass, true);
	assert.equal(scoreDraftTrace(ui.filter(({ t }) => t !== 6_001), words, 0, 13_000).pass, false);
});

test("freshness may match a repeated word in any optimal tail alignment, but not at the cost of LCS matches", () => {
	const repeated = [{ word: "yes", endMs: 0 }, { word: "now", endMs: 100 }, { word: "yes", endMs: 5_000 }, { word: "now", endMs: 11_000 }];
	assert.equal(scoreCheckpoint("Live: yes now", repeated, 7_000).pass, false);
	assert.equal(scoreCheckpoint("Live: yes now", repeated, 11_000).pass, true);
	assert.equal(scoreCheckpoint("Live: yes", repeated, 7_000).pass, false);
});

test("a relevant left-clipped revision can advance the visible reference boundary, but a stale label cannot", () => {
	const ui = [
		{ t: 2_000, line: "Live: one two" },
		{ t: 3_500, line: "Live: one two" },
		{ t: 5_000, line: "Live: …three four five" },
	];
	assert.equal(previewProgress(ui.slice(0, 2), words, 0, 6_000).multiple, false);
	const updated = previewProgress(ui, words, 0, 6_000);
	assert.equal(updated.multiple, true);
	assert.deepEqual(updated.growingCorrectPrefixes.map(({ referenceThrough }) => referenceThrough), [2, 5]);
	assert.equal(previewProgress(ui, words, 0, 5_000).multiple, false);
});

test("a decoder boundary must not repeat words that were spoken once", () => {
	const replayed = extraBoundaryRepeats("wait here i will go in quest of this knight", ["Wait here. I will go in", "Here, I will go in quest of this night."]);
	assert.deepEqual(replayed, [{ betweenFinals: [0, 1], words: ["here", "i", "will", "go", "in"] }]);
	assert.deepEqual(extraBoundaryRepeats("but now but now we're here", ["But now", "but now we're here"]), []);
});

test("word errors preserve repetitions and use the spoken words as denominator", () => {
	assert.deepEqual(wordErrors("BUT, now, but now.", "But no now!"), { words: 4, substitutions: 1, deletions: 1, insertions: 0, wer: 0.5 });
	assert.deepEqual(wordErrors("", "Thank you"), { words: 0, substitutions: 0, deletions: 0, insertions: 2, wer: null });
});

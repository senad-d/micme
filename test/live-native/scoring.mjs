import { stripVTControlCharacters } from "node:util";

export function tokens(text) {
	return text.normalize("NFC").toLowerCase().replaceAll("’", "'").match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu) ?? [];
}

export function visibleWords(line) {
	const content = stripVTControlCharacters(line ?? "");
	return content.startsWith("Live: ") ? tokens(content.slice(6).replace(/^…/, "")) : [];
}

// Pairs (matches, anyRecent) are encoded as 2*matches + anyRecent. Maximizing
// this value first maximizes LCS length and then picks a recent match if one
// exists in ANY optimal alignment (important for repeated reference words).
function alignment(displayed, spoken, recentAfter) {
	const dp = new Uint32Array(spoken.length + 1);
	for (const word of displayed) {
		let diagonal = 0;
		for (let j = 1; j <= spoken.length; j++) {
			const above = dp[j];
			dp[j] = Math.max(above, dp[j - 1]);
			if (word === spoken[j - 1].word) {
				const recent = Number(spoken[j - 1].endMs >= recentAfter);
				dp[j] = Math.max(dp[j], (diagonal + 2) | recent);
			}
			diagonal = above;
		}
	}
	const best = dp.at(-1);
	return { matches: best >> 1, recent: Boolean(best & 1) };
}

export function scoreCheckpoint(visible, words, atMs) {
	const displayed = visibleWords(visible);
	const tail = displayed.slice(-8);
	const spoken = words.filter(({ endMs }) => endMs <= atMs);
	const full = alignment(displayed, spoken, atMs - 5_000);
	const last = alignment(tail, spoken, atMs - 5_000);
	const precision = full.matches / (displayed.length || 1);
	const tailPrecision = last.matches / (tail.length || 1);
	return { atMs, referenceWords: spoken.length, lastSpoken: spoken.at(-1) ?? null, visible, displayed, precision, tailPrecision,
		recentTailMatch: last.recent, pass: displayed.length >= 2 && precision >= 0.75 && tailPrecision >= 0.75 && last.recent };
}

export function scoreDraftTrace(ui, words, onsetMs, endMs) {
	const checkpoints = [];
	for (let atMs = onsetMs + 4_000; atMs < endMs; atMs += 2_000) {
		// Never look forward, even when the next refresh is only a millisecond later.
		const visible = ui.findLast(({ t }) => t <= atMs)?.line ?? "";
		checkpoints.push(scoreCheckpoint(visible, words, atMs));
	}
	const hits = checkpoints.filter(({ pass }) => pass).length;
	const adjacentMisses = checkpoints.some(({ pass }, i) => !pass && i > 0 && !checkpoints[i - 1].pass);
	return { pass: checkpoints.length > 0 && hits / checkpoints.length >= 0.8 && !adjacentMisses, hits, adjacentMisses, checkpoints };
}

export function previewProgress(ui, words, onsetMs, beforeMs) {
	const ends = [];
	let firstMs = null;
	for (const { t, line } of ui) {
		if (t < onsetMs || t >= beforeMs) continue;
		const d = visibleWords(line);
		const spoken = words.filter(({ endMs }) => endMs <= t);
		if (firstMs === null && d.some((word, i) => i + 1 < d.length && spoken.some((w, j) => w.word === word && spoken[j + 1]?.word === d[i + 1]))) {
			firstMs = t - onsetMs;
		}
		if (!scoreCheckpoint(line, words, t).pass || ends.at(-1)?.line === line) continue;
		// A narrow display clips older words by design. Count an advancing span
		// in its visible suffix, not letters that the narrow widget never shows.
		const lastStart = stripVTControlCharacters(line).startsWith("Live: …") ? spoken.length - 2 : 0;
		let boundary = ends.at(-1)?.referenceThrough ?? 0;
		for (let start = 0; start <= lastStart; start++) {
			let n = 0;
			while (start + n < spoken.length && spoken[start + n].word === d[n]) n++;
			if (n >= 2) boundary = Math.max(boundary, start + n);
		}
		if (boundary > (ends.at(-1)?.referenceThrough ?? 0)) ends.push({ t, referenceThrough: boundary, line });
	}
	return { firstCorrectMs: firstMs, growingCorrectPrefixes: ends, multiple: ends.length >= 2 };
}

export function nearestRank(values, p) {
	const sorted = values.map((x) => x ?? Infinity).sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * p) - 1] ?? Infinity;
}

export function hasKeywords(text, keywords) {
	const wanted = tokens(keywords);
	let i = 0;
	for (const word of tokens(text)) if (word === wanted[i]) i++;
	return i === wanted.length;
}

// A VAD or rollover boundary must not introduce a copy of a tail at the start
// of the next final span. Keep real repetitions that occur in the reference.
export function extraBoundaryRepeats(reference, finals) {
	const expected = tokens(reference);
	const spans = finals.map(tokens).filter(({ length }) => length > 0);
	const repeated = [];
	for (let i = 1; i < spans.length; i++) {
		const previous = spans[i - 1];
		const current = spans[i];
		for (let n = Math.min(previous.length, current.length); n > 0; n--) {
			const tail = previous.slice(-n);
			if (!tail.every((word, j) => current[j] === word)) continue;
			const candidate = [...tail, ...tail];
			if (!expected.some((_, j) => candidate.every((word, k) => expected[j + k] === word))) {
				repeated.push({ betweenFinals: [i - 1, i], words: tail });
			}
			break;
		}
	}
	return repeated;
}

// Deterministic tie break: substitution, then deletion, then insertion. WER is
// independent of the tie break. A zero-word reference has no defined WER.
export function wordErrors(reference, result) {
	const r = tokens(reference);
	const d = tokens(result);
	const dp = Array.from({ length: r.length + 1 }, () => new Uint32Array(d.length + 1));
	for (let i = 0; i <= r.length; i++) dp[i][0] = i;
	for (let j = 0; j <= d.length; j++) dp[0][j] = j;
	for (let i = 1; i <= r.length; i++) {
		for (let j = 1; j <= d.length; j++) {
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + Number(r[i - 1] !== d[j - 1]));
		}
	}
	let i = r.length;
	let j = d.length;
	const counts = { substitutions: 0, deletions: 0, insertions: 0 };
	while (i || j) {
		if (i && j && dp[i][j] === dp[i - 1][j - 1] + Number(r[i - 1] !== d[j - 1])) {
			if (r[--i] !== d[--j]) counts.substitutions++;
		} else if (i && dp[i][j] === dp[i - 1][j] + 1) {
			i--;
			counts.deletions++;
		} else {
			j--;
			counts.insertions++;
		}
	}
	return { words: r.length, ...counts, wer: r.length ? dp[r.length][d.length] / r.length : null };
}

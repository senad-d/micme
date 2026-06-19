# Task List: Streaming Text Append-Only Reliability

Related spec: [`specs/spec-streaming-text-findings.md`](./spec-streaming-text-findings.md)

## Goal

Implement streaming mode so Micme treats `whisper-stream` output as repeated hypotheses from overlapping audio windows, then commits words append-only into the editor. Live editor text must grow monotonically and must not visibly delete/replace previously shown words.

## Current Code Context

These snippets are the main places that explain the current behavior.

### `src/streaming.ts`: pending words are rendered into the editor

```ts
export function getStreamingTranscript(state: StreamingState) {
	return [...state.emittedWords, ...state.pendingWords].join(" ");
}

export function renderStreamingPreview(ctx: ExtensionContext, state: StreamingState, trailingSpace: boolean) {
	const transcript = getStreamingTranscript(state);
	const suffix = transcript ? `${transcript}${trailingSpace ? " " : ""}` : "";
	const nextText = `${state.baseText}${suffix}`;
	if (nextText === state.previewText) return;
	ctx.ui.setEditorText(nextText);
	state.previewText = nextText;
}
```

Problem: `pendingWords` are speculative, but they are written into the editor. When the next hypothesis changes, the editor is rewritten.

### `src/streaming.ts`: current stability logic

```ts
export function queueStableStreamingWords(ctx: ExtensionContext, state: StreamingState, currentWords: string[]) {
	// Popular Whisper streaming frontends use local agreement: show/commit only the common prefix of consecutive hypotheses.
	const stableCount = commonStreamingPrefixLength(state.pendingWords, currentWords);
	const maxConfirmed = state.emittedWords.length === 0 && currentWords.length < STREAM_MIN_INITIAL_WORDS ? 0 : stableCount;
	const confirmedCount = Math.min(maxConfirmed, getStreamWordsPerChunk());
	if (confirmedCount > 0) queueStreamingWords(state, currentWords.slice(0, confirmedCount));
	state.pendingWords = currentWords.slice(confirmedCount);
	renderStreamingPreview(ctx, state, false);
}
```

Problem: this local-agreement approach can overwrite pending words before they are committed, and rendering still exposes the unstable pending part.

### `src/streaming.ts`: current emitted-suffix diff

```ts
export function diffStreamingText(previous: string, current: string) {
	const previousWords = splitStreamingWords(previous);
	const currentWords = splitStreamingWords(current);
	if (currentWords.length === 0) return "";
	const overlap = streamingWordOverlap(previousWords, currentWords);
	return currentWords.slice(overlap).join(" ");
}
```

Problem: this assumes current frames can be anchored against already emitted words. It is weak for incremental frames (`Cat`, `is`, `white`) and rolling windows (`Cat is`, `is white`).

### `src/types.ts`: flush timer exists but is unused

```ts
export type StreamingState = {
	baseText: string;
	previewText: string;
	outputBuffer: string;
	lastText: string;
	pendingWords: string[];
	emittedWords: string[];
	startedAt: number;
	firstOutputAt?: number;
	firstPreviewAt?: number;
	flushTimer?: ReturnType<typeof setTimeout>;
};
```

Problem: `flushTimer` can support pause-based commits, but no code currently schedules it.

### `src/streaming.ts`: `--keep-context` is enabled by Micme default

```ts
if (getStreamKeepContext()) args.push("--keep-context");
```

From the spec: upstream `whisper-stream --help` defaults `--keep-context` to false. Micme's stream profile currently enables it, which can encourage contextual correction/combination behavior.

---

## Tasks

- [x] **1. Add deterministic streaming state tests before refactoring**

  Build tests around `src/streaming.ts` using a fake `ExtensionContext` whose `ctx.ui.setEditorText(...)` records every editor update.

  Cover at least these input patterns from the spec:

  ```text
  cumulative:  Cat -> Cat is -> Cat is white
  incremental: Cat -> is -> white
  rolling:     Cat is -> is white
  correction:  Cat is -> That is -> Cat is white
  reset/noise: [BLANK_AUDIO], thank you, empty frames
  ```

  Reference: [`specs/spec-streaming-text-findings.md`](./spec-streaming-text-findings.md), sections "Problem Statement", "Likely Root Causes", and "Testing Strategy".

  **Acceptance Criteria**

  - Tests fail against the current implementation for at least one visible rewrite/shrink case.
  - Tests assert that live editor updates never remove an already committed suffix.
  - Tests assert no duplicate words for rolling overlap cases.
  - Tests can be run with the repo's validation flow or a clearly documented test command.

- [x] **2. Add opt-in stream diagnostics for frame/state investigation**

  Extend `MICME_STREAM_DIAGNOSTICS=1` so it can report sanitized frames and state transitions without changing normal user output.

  Useful fields:

  ```ts
  rawFrame
  sanitizedText
  frameWords
  emittedWords
  pendingWords // or candidateWords after refactor
  previewText
  extractionMode // cumulative | incremental | rolling | duplicate | reset
  ```

  Current diagnostic hook:

  ```ts
  if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
	ctx.ui.notify(`Micme stream first preview: ${state.firstPreviewAt - state.startedAt} ms`, "info");
  }
  ```

  **Acceptance Criteria**

  - Diagnostics are only active when `MICME_STREAM_DIAGNOSTICS=1`.
  - Diagnostics include enough data to explain why a frame committed, stayed pending, or was ignored.
  - Normal streaming mode emits no extra logs/notifications beyond existing status behavior.
  - Sensitive/local file paths are not added to diagnostics unnecessarily.

- [x] **3. Refactor `StreamingState` to separate committed and tentative text**

  Replace the current overloaded `pendingWords` behavior with explicit state semantics.

  Proposed direction:

  ```ts
  export type StreamingState = {
	baseText: string;
	previewText: string;
	outputBuffer: string;
	lastText: string;
	emittedWords: string[];      // committed, already shown in editor
	candidateWords: string[];    // tentative, not shown by default
	lastHypothesisWords: string[];
	startedAt: number;
	firstOutputAt?: number;
	firstPreviewAt?: number;
	flushTimer?: ReturnType<typeof setTimeout>;
  };
  ```

  Keep names flexible, but the meaning must be clear: committed words are immutable during a stream; tentative words may change internally.

  **Acceptance Criteria**

  - The state type clearly distinguishes committed words from tentative hypotheses.
  - Existing stream lifecycle initialization in `src/extension.ts` is updated to initialize the new fields.
  - No editor rendering function needs to inspect tentative words unless an explicit diagnostic/preview feature asks for it.
  - TypeScript passes after the refactor.

- [x] **4. Replace frame diffing with robust new-word extraction**

  Replace or wrap `diffStreamingText(...)` with logic that treats `whisper-stream` frames as hypotheses from repeated overlapping windows.

  The extraction helper should classify frames similar to:

  ```ts
  type StreamingFrameMode = "cumulative" | "incremental" | "rolling" | "duplicate" | "reset";

  function extractStreamingCandidate(state: StreamingState, frameWords: string[]): {
	mode: StreamingFrameMode;
	newWords: string[];
  };
  ```

  It should handle:

  - cumulative frames: `Cat` -> `Cat is` -> `Cat is white`
  - incremental frames: `Cat` -> `is` -> `white`
  - rolling windows: `Cat is` -> `is white`
  - duplicate frames without re-adding words
  - reset/hallucination frames without clearing committed text

  Use existing normalization helpers where possible:

  ```ts
  export function normalizeStreamingWord(word: string) {
	const normalized = word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	return normalized || word.toLowerCase();
  }
  ```

  **Acceptance Criteria**

  - Cumulative, incremental, and rolling test fixtures all produce the intended final transcript.
  - Duplicate frames do not duplicate committed words.
  - Hallucination/reset frames do not delete committed words.
  - Original word casing/punctuation is preserved for committed output where possible.

- [x] **5. Change live rendering to append committed words only**

  Update `getStreamingTranscript(...)` / `renderStreamingPreview(...)` so live editor text is based on committed words only.

  Current problematic behavior:

  ```ts
  return [...state.emittedWords, ...state.pendingWords].join(" ");
  ```

  Desired live behavior:

  ```ts
  return state.emittedWords.join(" ");
  ```

  Tentative text may still exist internally, but it should not be placed in the editor by default.

  **Acceptance Criteria**

  - During live streaming, `ctx.ui.setEditorText(...)` never removes or replaces previously rendered stream text.
  - Candidate/tentative words are not rendered into the editor by default.
  - `Cat is white` can appear as `Cat`, then `Cat is`, then `Cat is white`, or as one append, but never as visible correction churn.
  - Auto-submit behavior still sends the committed live transcript correctly when final clip mode is disabled.

- [x] **6. Implement pause-based commit using `flushTimer`**

  Use the existing `flushTimer` field to commit candidate words after a short quiet interval when no newer frame arrives.

  Current code only clears the timer:

  ```ts
  export function clearStreamingFlush(state: StreamingState) {
	if (!state.flushTimer) return;
	clearTimeout(state.flushTimer);
	state.flushTimer = undefined;
  }
  ```

  Add scheduling near candidate updates, for example:

  ```ts
  scheduleStreamingFlush(ctx, state);
  ```

  The delay can start as a constant or config-backed value. It should be short enough that phrases like `Cat is white` do not remain invisible until stop, but long enough to avoid committing obvious transient noise.

  **Acceptance Criteria**

  - Candidate words commit after a quiet interval even if no later matching frame arrives.
  - New frames cancel/reschedule the pending flush safely.
  - Stop-time cleanup clears the timer and flushes final candidates when appropriate.
  - Tests cover pause flush and stop flush behavior.

- [x] **7. Revisit stream defaults and command flags**

  Based on the spec's documentation finding, update the stream profile for append-only dictation.

  Current stream profile in `src/config.ts`:

  ```ts
  MICME_STREAM_KEEP_CONTEXT: "1",
  MICME_STREAM_FINALIZE_WITH_CLIP: "0",
  ```

  Consider changing `MICME_STREAM_KEEP_CONTEXT` to `0` in the stream profile because upstream `whisper-stream` defaults it to false and raw dictation should not encourage correction across chunks.

  Also revisit:

  ```ts
  export const STREAM_MIN_INITIAL_WORDS = 2;
  export const STREAM_PROFILE_WORDS_PER_CHUNK = 5;
  ```

  **Acceptance Criteria**

  - The chosen `MICME_STREAM_KEEP_CONTEXT` default is explicitly justified in code comments or docs.
  - Stream profile keeps `MICME_STREAM_FINALIZE_WITH_CLIP=0` unless intentionally changed.
  - First-word behavior is acceptable for short phrases like `Cat is white`.
  - `/micme conf` values remain consistent with the new defaults.

- [x] **8. Preserve explicit final clip replacement semantics**

  Review stop-time stream behavior in `src/extension.ts`:

  ```ts
  if (!active.clipRecording) {
	flushPendingStreamingWords(ctx, state);
	const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
	// ...
  } else {
	renderStreamingPreview(ctx, state, false);
  }
  ```

  And:

  ```ts
  await pasteOrSubmitFinalStreamingTranscript(ctx, pi, state, normalized);
  ```

  Ensure final clip mode is clearly opt-in because it can replace the live append-only transcript with a new full transcript.

  **Acceptance Criteria**

  - With `MICME_STREAM_FINALIZE_WITH_CLIP=0`, stop keeps and flushes the append-only live transcript.
  - With `MICME_STREAM_FINALIZE_WITH_CLIP=1`, replacement is intentional and documented.
  - If final clip transcription fails, the committed live transcript remains available.
  - `lastTranscript` is set to the correct transcript for both modes.

- [x] **9. Update configuration UI, schema, example, and README**

  Update user-facing text to explain the new append-only behavior and `whisper-stream` limitation.

  Files to review:

  ```text
  src/settings.ts
  micme.example.json
  micme.schema.json
  README.md
  ```

  Current README says:

  ```md
  | `MICME_TRANSCRIPTION_MODE=stream` | Experimental live preview with `whisper-stream`. |
  ```

  Expand this to clarify that streaming is append-only live dictation after the fix, while final clip mode can still replace text if enabled.

  **Acceptance Criteria**

  - README describes stream mode as append-only live dictation, not perfect word-level streaming from Whisper itself.
  - Settings descriptions explain `MICME_STREAM_KEEP_CONTEXT` and final clip replacement trade-offs.
  - Example config reflects the chosen new defaults.
  - Schema includes any new config key if a flush-delay or preview-mode setting is introduced.

- [ ] **10. Manual validation with real `whisper-stream`**

  Run from the checkout with diagnostics enabled:

  ```bash
  MICME_TRANSCRIPTION_MODE=stream MICME_STREAM_DIAGNOSTICS=1 pi -e .
  ```

  Test phrases:

  ```text
  Cat is white
  open the file
  create a new function called parse input
  now write the tests and run them
  ```

  Test both fast speech and normal speech. Also compare `MICME_STREAM_KEEP_CONTEXT=0` vs `1` before finalizing defaults.

  Status: not run in this non-interactive implementation session; use the command above for microphone validation.

  **Acceptance Criteria**

  - Live editor text only grows during streaming; it does not visibly delete or replace prior words.
  - Short fast phrases produce the expected ordered transcript.
  - Rolling/incremental frame behavior seen in diagnostics matches the test assumptions or is documented if different.
  - Any remaining known limitation is added to the spec or README before closing the task.

- [x] **11. Final validation and cleanup**

  Run the standard checks:

  ```bash
  npm run typecheck
  npm run check
  npm run validate
  ```

  Review the final diff for accidental broad rewrites outside streaming/config/docs/tests.

  **Acceptance Criteria**

  - All validation commands pass.
  - Streaming task tests pass.
  - No unrelated formatting or behavior changes are included.
  - `specs/spec-streaming-text-findings.md` and this task list still match the implemented behavior.

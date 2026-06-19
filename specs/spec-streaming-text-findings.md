# Plan: Streaming Text Append-Only Reliability

## Task Description

Investigate why Micme's experimental streaming mode visibly types text, removes/replaces it, and fails to preserve short fast-spoken phrases such as "Cat is white". No runtime code changes are included in this step; this document captures findings and a proposed implementation plan for a follow-up fix.

## Objective

Make streaming mode behave like append-only dictation: once a word is shown/committed in the editor, Micme should not revise or delete it during live streaming. For fast speech, the live transcript should append words in sequence (for example: `Cat` → `Cat is` → `Cat is white`) rather than repeatedly replacing speculative hypotheses.

## Problem Statement

The current implementation treats each `whisper-stream` line as a fresh hypothesis, renders unstable `pendingWords` directly into the editor, and then rewrites the entire editor preview whenever the next hypothesis differs. This matches the user-visible failure: the editor shows one guess, removes it, shows another, and may lose the exact spoken sequence when short phrases cross streaming chunks.

Whisper streaming output is not guaranteed to be append-only. With short `--step` intervals and overlapping audio windows, consecutive frames can be cumulative, incremental, rolling-window fragments, or corrected hypotheses. The application needs an append-only commit policy on top of those frames instead of exposing every speculative rewrite to the editor.

## Current Implementation Findings

### Whisper-stream Documentation Findings

Sources checked after the initial code investigation:

- Local installed whisper.cpp README: `/opt/homebrew/Cellar/whisper-cpp/1.9.0/README.md`.
- Local CLI help: `whisper-stream --help`.

Relevant documentation details:

- The README describes `whisper-stream` as a **naive real-time inference example** for microphone audio.
- The stream tool "samples the audio every half a second and runs the transcription continuously"; the documented example uses `--step 500 --length 5000`.
- CLI options confirm the model operates on repeated audio windows controlled by `--step`, `--length`, and `--keep`, with optional `--keep-context` disabled by upstream default.
- The docs do not describe `whisper-stream` as producing committed word-level deltas. Its stdout should be treated as repeated hypotheses over a moving/overlapping audio window, not as an append-only transcript stream.

Implication: Micme must add its own append-only commit layer if the product goal is word-by-word dictation. We should not assume `whisper-stream` itself will output stable incremental words.

### Micme Code Findings

- `src/extension.ts` starts stream mode by spawning `whisper-stream`, saving `baseText`, and piping stdout into `handleStreamingOutput`.
- `src/streaming.ts` parses stdout frames split by `\r`/`\n`, sanitizes control tokens, and calculates `next` with `diffStreamingText(emittedWords.slice(-160), currentFrame)`.
- `queueStableStreamingWords` uses local agreement between prior `pendingWords` and current `next` words, then stores the rest as new `pendingWords`.
- `renderStreamingPreview` writes `baseText + emittedWords + pendingWords` via `ctx.ui.setEditorText(...)`, so pending/unstable words are visible and can be replaced on every frame.
- `STREAM_MIN_INITIAL_WORDS = 2` prevents the first single word from being committed immediately.
- `flushTimer` exists in `StreamingState` but is never scheduled, so short final pending phrases only commit on explicit stop or a later matching frame.
- `MICME_STREAM_KEEP_CONTEXT` defaults to enabled in Micme's stream profile, while `whisper-stream --help` shows upstream `--keep-context` defaults to false. Keeping context can make Whisper condition future chunks on previous hypotheses, which is useful for continuity but can also encourage correction/combination behavior the user does not want.
- If `MICME_STREAM_FINALIZE_WITH_CLIP=1`, stop-time finalization can replace the live preview with a clip-mode transcript. The stream profile sets it to `0`, but the generic default is `true` when unset.

## Likely Root Causes

1. **Unstable words are rendered as editor text.** The editor is updated with `pendingWords`, not only committed words, so any hypothesis change causes visible deletion/replacement.
2. **The diff model assumes mostly cumulative frames.** `diffStreamingText` only anchors the current frame against already emitted words. It does not robustly classify incremental or rolling-window output.
3. **Pending words can be overwritten before they commit.** A fast phrase can produce `Cat`, then `is`, then `white` as separate/rolling chunks; the current pending queue can replace `Cat` with `is` before `Cat` is emitted.
4. **No pause-based commit timer exists.** The unused `flushTimer` means short utterances can remain speculative until stop, making them vulnerable to the next hypothesis.
5. **Context retention may be too opinionated for raw dictation.** `--keep-context` can bias future chunks toward prior text and make Whisper revise/merge short sentences instead of behaving like simple word capture.

## Solution Approach

Shift streaming mode from "show each hypothesis" to "append committed words only".

The important UX invariant should be: live editor content after `baseText` is monotonic. During streaming, Micme may append words, but it must not remove or replace previously visible words. Any tentative recognition should be held internally or displayed outside the editor only if explicitly enabled.

### Recommended Direction

- Default streaming to an append-only commit policy.
- Render only committed words into the editor during live streaming.
- Keep tentative candidates in state, but do not expose them in the editor unless a future diagnostic/preview setting is enabled.
- Commit words when they are sufficiently safe by one of these mechanisms:
  - consecutive-frame local agreement,
  - robust overlap/anchor detection against the committed transcript,
  - a short no-update/pause timer using the existing `flushTimer`,
  - stop-time flush for the last candidate words.
- Change the stream profile so raw dictation does not pass `--keep-context` by default, or introduce a clearly named config mode/profile for `raw append-only` vs `contextual preview`.
- Keep final clip replacement opt-in in stream mode; if enabled, document that it may replace the live stream text.

## Relevant Files

- `src/streaming.ts` - Core frame parsing, sanitization, diffing, pending/emitted word state, editor rendering, and stop-time flush.
- `src/extension.ts` - Stream lifecycle, stdout event wiring, finalization path, and optional clip-mode final pass.
- `src/config.ts` - Stream profile defaults and getters for `MICME_STREAM_*` options.
- `src/constants.ts` - Streaming defaults such as `STREAM_MIN_INITIAL_WORDS`, step/length/keep/max-token defaults, and stream profile values.
- `src/settings.ts` - `/micme conf` UI descriptions and selectable streaming settings.
- `src/types.ts` - `StreamingState` shape; likely needs fields for candidate words, committed render text, and diagnostics.
- `micme.example.json` / `micme.schema.json` - Documented stream settings and examples.
- `README.md` - User-facing description of stream mode limitations and recommended settings.

### New Files

- A future test file should be added for streaming state transitions. Exact location can follow the chosen test runner, e.g. `test/streaming.test.mjs` or `src/streaming.test.ts`.

## Implementation Phases

### Phase 1: Characterize Current Streaming Frames

- Add diagnostics that can log sanitized frames and state transitions when `MICME_STREAM_DIAGNOSTICS=1`.
- Capture sample outputs for fast short phrases, slow phrases, pauses, and multi-sentence dictation.
- Confirm whether common `whisper-stream` frames are cumulative, incremental, rolling, or mixed for the current default settings.

### Phase 2: Append-Only Commit Model

- Refactor `StreamingState` so committed words and tentative candidate words are separate concepts.
- Change live rendering to use committed words only by default.
- Preserve the invariant that live editor text never shrinks after `baseText` during streaming.
- Implement a robust `extractNewWords(...)` function that can handle:
  - cumulative frames: `Cat` → `Cat is` → `Cat is white`,
  - incremental frames: `Cat` → `is` → `white`,
  - rolling frames: `Cat is` → `is white`,
  - harmless duplicate frames,
  - hallucination/reset frames.

### Phase 3: Commit Timing and Configuration

- Use the existing `flushTimer` field to commit pending/candidate words after a short quiet interval.
- Revisit defaults:
  - likely set stream profile `MICME_STREAM_KEEP_CONTEXT=0` for raw append-only dictation,
  - keep `MICME_STREAM_FINALIZE_WITH_CLIP=0` for stream profile,
  - consider `STREAM_MIN_INITIAL_WORDS=1` or replace it with a safer commit heuristic.
- Update `/micme conf`, examples, schema/docs, and README to explain append-only behavior and the trade-off: lower live correction, more predictable text.

### Phase 4: Tests and Manual Validation

- Add deterministic state-transition tests with a fake `ctx.ui` that records every `setEditorText` call.
- Assert that live editor updates are monotonic and never remove committed words.
- Validate both fast and slow dictation manually with `whisper-stream`.

## Step by Step Tasks

### 1. Add Streaming Diagnostics

- Log raw frame, sanitized text, emitted words, candidate words, and committed output when diagnostics are enabled.
- Keep diagnostics opt-in and avoid logging by default.

### 2. Define Append-Only State Semantics

- Rename or supplement `pendingWords` with clearer fields such as `candidateWords`, `lastHypothesisWords`, and `committedWords` if needed.
- Treat `emittedWords` as immutable committed editor content for the active stream.
- Ensure any candidate replacement does not rewrite the editor.

### 3. Refactor Frame Diffing

- Replace the current emitted-suffix-only diff with a helper that classifies frame shape:
  - full/cumulative hypothesis,
  - delta-only hypothesis,
  - rolling-window overlap,
  - duplicate/no-op,
  - reset/hallucination.
- Use normalized-word comparison for anchors, but preserve original words when committing.

### 4. Change Rendering Policy

- Render committed words only during live streaming.
- Optionally expose tentative text in a widget/status line later, but do not put unstable text into the editor by default.
- Keep stop-time flush behavior for leftover candidate words when no final clip pass is used.

### 5. Implement Pause-Based Commit

- Schedule `flushTimer` after receiving candidate words.
- If no newer frame arrives within the configured delay, commit the candidate words in order.
- Clear/reschedule the timer safely on every frame and on stream stop.

### 6. Revisit Stream Defaults

- Change the stream profile to avoid `--keep-context` by default unless testing proves it is necessary.
- Keep final clip replacement off in the stream profile.
- Consider adding a dedicated config key only if one behavior cannot satisfy both raw dictation and contextual preview users.

### 7. Add Tests

- Test cumulative frames: `Cat`, `Cat is`, `Cat is white` → final `Cat is white` with no shrinking editor updates.
- Test incremental frames: `Cat`, `is`, `white` → final `Cat is white`.
- Test rolling overlap: `Cat is`, `is white` → no duplicate `is` and no deletion.
- Test corrections: an unstable candidate can change internally, but already rendered editor text remains unchanged.
- Test hallucination/reset frames do not delete committed text.
- Test stop flush commits the last pending phrase when final clip pass is disabled.

### 8. Validate Manually

- Run the app in stream mode from the checkout.
- Dictate fast short phrases and verify words append in order.
- Dictate with pauses and verify pause-based flush commits the last words.
- Toggle `MICME_STREAM_KEEP_CONTEXT` and compare behavior before deciding the final default.

## Testing Strategy

Use deterministic unit/state tests first because the bug is largely in state management and editor rendering policy. Manual audio tests should validate real `whisper-stream` behavior after the state machine is fixed.

Important assertions:

- `ctx.ui.setEditorText` calls never shrink or replace the already committed suffix during live streaming.
- Committed words are appended once, not duplicated.
- Pending/candidate words can change internally without editor churn.
- Stop-time behavior is explicit: append pending live words or opt-in replace with final clip transcript.

## Acceptance Criteria

- During live streaming, Micme never removes or replaces words already shown in the editor.
- Fast phrase example `Cat is white` appends as a single ordered transcript, without visible correction churn.
- Incremental and cumulative frame patterns both produce the same committed transcript.
- `MICME_STREAM_KEEP_CONTEXT` behavior is documented and defaults align with append-only dictation.
- Streaming state-transition tests cover the known failure modes.
- No non-diagnostic stream logs are emitted by default.

## Validation Commands

Execute these commands after implementation:

```bash
npm run typecheck
npm run check
npm run validate
```

Manual validation example:

```bash
MICME_TRANSCRIPTION_MODE=stream MICME_STREAM_DIAGNOSTICS=1 pi -e .
```

Then dictate: `Cat is white`, `open the file`, and a longer fast sentence. Confirm editor text only grows and never rewrites prior words.

## Notes

- This investigation did not change runtime code.
- True word-by-word recognition is limited by Whisper's chunk-level decoding. The realistic product goal is append-only display of committed words, not exposing Whisper's intermediate revisions.
- If maximum final accuracy is more important than append-only UX, clip mode or opt-in final clip replacement remains the safer path.

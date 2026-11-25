# Unrelated live dictation

Kind: bug

## Purpose and scope

“Streaming … produces totally unrelated text.” Fix the two demonstrated ways Micme admits false text and the separate-input ambiguity. The objective is **words during speech**, not merely a better clip after stop. The [investigation](../research/local-dictation.md) identifies which results came from code, upstream sources and the running app; none is a native reproduction of this person's dictation.

## Reports

| Id | Reported, in the reporter's words | Where |
| --- | --- | --- |
| B1 | “it produces totally unrelated text” — a discarded guess can become durable text | Positive-step stream → Pi editor |
| B2 | “the performance and configuration are lacking” — apparent VAD/token tuning does not gate the active decoder | Streaming settings/profile |
| B3 | “streaming … is not functioning at all” — live and clip may not hear the same source | SDL default vs configured recorder |

## Reproduction

| Id | Steps or input | What happens | What should happen |
| --- | --- | --- | --- |
| B1 | Native-style redraw of “The ocean is blue”, then “Please open system settings” in the same group; finish and stop. | Source trace: matcher commits both (four insertions). A lone draft can instead outlast the 700 ms flush. Real “Okay.” is filtered. | First guess must be replaceable, not sent; acoustically supported short speech must be eligible. |
| B2 | Select stream via file or TUI and adjust VAD/max tokens. | Running UI showed the slider; upstream v1.8.3/v1.9.6 source shows positive steps never consult it and max tokens is overwritten. | Actual speech detector before ASR; no knob claiming to control an inactive path. |
| B3 | Choose FFmpeg microphone in Audio, then stream with default capture −1. | Source trace: live opens SDL default; final clip optionally opens an independent recorder. Unverified: the user's actual SDL input or silence. | One captured signal throughout. A working clip from that signal should be a meaningful comparison. |

## Cause

| Id | File and symbol | Why | Certainty |
| --- | --- | --- | --- |
| B1 | `src/streaming.ts:extractStreamingCandidate`, `queueStableStreamingWords`, `flushPendingStreamingWords` | A disjoint rewrite looks like a new phrase. Missing stdout becomes an acoustic pause; stop promotes remaining words. | Control flow verified; example source-traced, not a native decode. |
| B2 | `src/streaming.ts:buildWhisperStreamCommand`; [upstream flags and modes](../research/local-dictation.md#what-whisper-stream-actually-supplies) | Both profiles send positive `--step`; no silence gating, `--vad-thold` inactive and `--max-tokens` ignored. More short windows can mean *more* ungrounded guesses. | Verified in pinned source. |
| B3 | `src/extension.ts:startStreamingTranscription`, `src/audio.ts:buildRecorderCommand` | SDL capture ID and OS recorder selector are separate namespaces. A synthetic meter based on text cannot diagnose it. | Separate capture verified; input mismatch is a candidate for the user's report, not a diagnosis. |

## Fix

| Id | What changes | What stays although it looks related |
| --- | --- | --- |
| B1 | Consume typed audio-range draft/final results. Replace a draft on correction; only worker-final text reaches editor or last transcript. Remove phrase blacklist and stdout silence timer from the active path. | Terminal sanitization, observable TUI additions and successful final-pass opt-in. In write-only RPC, save the live result for explicit replay instead of automatically writing/sending into unknown host state. |
| B2 | Gate decoder work on real local VAD probabilities **before** recognition; make settings match the actual engine. | Whisper weights, language overrides and clip mode remain local; no universal accuracy claim. |
| B3 | Capture once with configured device/recorder; meter, decoder and optional stop-time transcription reference the same recorded samples. | Existing OS selectors, custom clip hooks and safe recording-directory ownership. |

## Regression checks

| Id | Behaviour a test must prove | Nearby behaviour that must still hold |
| --- | --- | --- |
| B1 | Wrong draft → unrelated corrected draft → valid final leaves only final in TUI editor/saved result (RPC: saved result only); a long wait/stop without a valid final never inserts the guess. | Real repeated words at distinct sample offsets survive. A real short “Okay” is eligible. |
| B2 | Known silence produces neither speculative text nor submissions; prolonged voiced input produces a recognizable preview before a pause. | Quiet speech, brief hesitations, selected language and translation work; see hardening proof for native measurements. |
| B3 | One recorder invocation and continuous sample counts through stop even when inference is slow; optional final reads that capture. | Keep-audio/error policies, device override, cancellation, spontaneous exit and partial-audio retention remain safe. |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Minimum meaningful repair | One acoustic path plus typed speech-gated results. | More banned phrases, step zero, or enabling final clip for everyone. | Those can hide some errors or fix text after stop but cannot prove a correct live update during speech. |

## Open questions

| Question | Who can answer | What waits for it |
| --- | --- | --- |
| Unverified: which device, noise, model or parameter contributed most on the user's machine? | Matched capture and reference transcript on that machine | Only attribution of this specific incident. The reproduced-by-source defects and the single-input fix do not wait. |

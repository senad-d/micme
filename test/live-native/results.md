# Native dictation: reference-host result

See the [replay procedure](README.md) and the [gate definitions](../../docs/specs/local-dictation-hardening.md#proof).

## Issue #161: CPU matrix kernels on the same host

Both matrices were run on 2026-11-28 on Linux x86-64 `7.0.0-44-generic`, Intel Core i5-7500 at 3.40 GHz (four available cores, 14.7 GiB RAM), Node 24.22.3 and FFmpeg 6.1.1. Both workers are GCC 13.3.0 / CMake 3.31.10 Release builds of the pinned whisper.cpp `96ec4d9823e9d0211944172da35f9f29134af990`, with native CPU and OpenMP, without BLAS or GPU backends. Both use the same four Whisper threads and one Silero thread. The baseline is Micme `0bdda36` (then-current `main`); the final worker enables ggml's bundled tiled CPU kernels (`GGML_LLAMAFILE=ON`). Both runs use the same clip binary, recordings, references, scoring and thresholds, with refinement off for the comparison. The replay context in both runs supplies the empty session history now required by the extension.

| Input | SHA-256 |
| --- | --- |
| Baseline worker (`GGML_LLAMAFILE=OFF`) | `fe9c9cfafaeaf2e7a7a3fb87a4cb2d31e72a5c82e9baceb2124b443aa8fbeaff` |
| Final worker (`GGML_LLAMAFILE=ON`) | `eba0908c8f4527c4fdc41e731a34324b68184722054f13278dc5058770bce2f7` |
| Shared `whisper-cli` | `7792df4a2059f82c38362e6a04e70afa8f15268af6f9fcae1c2cacbc04d8b280` |
| Shared `ggml-base.en.bin` | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| Shared `ggml-small.en.bin` | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
| Shared `ggml-base.bin` (French control) | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| Shared `ggml-silero-v5.1.2.bin` | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |

### Where the time went

Separate instrumented workers replayed the exact frame sequence from each model's first baseline run at 80 columns, without pacing. These timings are diagnostic; they are not included in the paced result below. Encoder and decoder are Whisper's reported stages; preview, rollover and endpoint time are inclusive and should not be added to those stages.

| Time in seconds (baseline → final) | `base.en` | `small.en` |
| --- | ---: | ---: |
| Whisper encoder | 7.87 → 4.30 | 25.84 → 12.99 |
| Whisper decoder | 6.30 → 6.37 | 12.37 → 12.59 |
| Preview calls | 12.49 → 9.66 | 30.96 → 20.87 |
| Rollover call | 1.54 → 1.27 | 3.63 → 2.68 |
| Last endpoint call | 1.37 → 0.99 | 4.60 → 3.02 |
| Silero inference | 0.26 → 0.19 | 0.23 → 0.17 |

The encoder accounted for most of the time saved. In the paced matrices, model loads were about 106–113 ms for `base.en` and 259–271 ms for `small.en` (OS caches not forced cold); the first native final reached the editor in at most 3.02 ms.

### Before and after

Each timing cell is baseline → final, with nearest-rank median / p95 over five runs. Draft time starts at speech onset; editor commit time starts at capture. ASR seconds per second of audio count native work, not time waiting for input.

| Model | Columns | ASR s/audio s | First correct draft (s) | First editor commit (s) | Final WER | Relevant runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `base.en` | 80 | 0.485 / 0.494 → 0.338 / 0.348 | 1.457 / 1.461 → 1.336 / 1.343 | 21.958 / 22.156 → 21.341 / 21.563 | 8.93% → 8.93% | 5/5 → 5/5 |
| `base.en` | 40 | 0.477 / 0.492 → 0.344 / 0.352 | 1.458 / 1.574 → 1.334 / 1.457 | 21.824 / 22.000 → 21.531 / 21.579 | 8.93% → 8.93% | 5/5 → 5/5 |
| `small.en` | 80 | 1.077 / 1.092 → 0.883 / 0.907 | 2.169 / 2.288 → 1.696 / 1.843 | 24.096 / 24.645 → 23.030 / 23.186 | 6.25% → 6.25% | 5/5 → 5/5 |
| `small.en` | 40 | 1.067 / 1.079 → 0.905 / 0.921 | 2.168 / 2.178 → 1.698 / 1.816 | 24.511 / 24.961 → 23.268 / 23.831 | 6.25% → 6.25% | 2/5 → 4/5 |

Median ASR compute fell 28–30% for `base.en` and 15–18% for `small.en`. All ten final `small.en` runs spent less than one second on ASR per second of audio. That is a compute result, not a guarantee that each visible draft kept up: `small.en` hit 72 → 71 of 80 checkpoints at 80 columns and 65 → 68 at 40 columns, with consecutive misses in one final narrow run. `base.en` is already the English stream default; `small.en` remains the English clip default. Neither default changed.

Both matrices exited 0 through `base.en` and the same-language French control. All 41 live runs in each matrix matched the input PCM byte for byte and passed editor delivery. Both English models had 0% live WER on JFK, short, quiet, paused speech and the overload control. Silence, rain and immediate stop produced no words and made no ASR calls. `base.en` preserved the deliberate “but now, but now” repeat; `small.en` still omitted it in both matrices (18.18% WER on that control).

## Independent rerun: `base.en` passes during continuous speech

On the four-core i5-7500, `base.en` passed every timed checkpoint while speech was still in progress, with refinement off. Two separate Release builds produced the same worker (SHA-256 `e624c8d1c4594b61367afa30ac8ef60a2c2a89433af38c6bb2a386b9a65a10fe`); both full matrices passed with `base.en`. The decoder now reuses an acoustic boundary for lighter-model draft windows and waits for more speech or agreement before displaying an uncertain suffix. The audio, references, timed scorer and thresholds did not change. The separate final-year check rejects “eighteen sixty four. Three.”

The table and [all 320 visible checkpoints](reference-checkpoints.tsv) are from the independent rerun. The latency is from speech onset to the first correct pair of visible words, not to an endpoint or editor write.

| Model | Columns | Hits out of 16, in run order | Passing runs | First correct draft, median / p95 |
| --- | ---: | --- | ---: | ---: |
| `base.en` | 80 | 16, 16, 16, 16, 16 | 5/5 | 1.459 / 1.480 s |
| `base.en` | 40 | 16, 16, 16, 16, 16 | 5/5 | 1.455 / 1.568 s |
| `small.en` | 80 | 14, 11, 12, 14, 13 | 3/5 | 2.182 / 2.902 s |
| `small.en` | 40 | 13, 13, 13, 14, 12 | 3/5 | 2.172 / 2.293 s |

- **While speaking:** `base.en` spent 0.45–0.61 seconds on ASR per second of continuous audio. The first editor commit came at 21.65–22.64 seconds from capture, well after the first visible draft. `small.en` took 1.07–1.15 seconds of ASR per second of audio and missed 31 checkpoints. At the time, the recommendation was to use `base.en` for English feedback on a similar CPU, even though `small.en` was still the default.
- **At stop:** continuous clip → live word error rate was 53.57% → 8.93% for `base.en` and 51.79% → 6.25% for `small.en`. Both captured the final year without a duplicated rollover phrase. JFK, short, quiet and paused speech had 0% live WER for both. Only `base.en` kept the deliberate “but now, but now” repeat. The French control with multilingual `base` returned “Paris.”
- **Audio and delivery:** all 41 live runs matched the input PCM byte for byte and passed the editor delivery checks. Silence, rain and immediate stop produced no visible or committed words and made no ASR calls. These are comparisons against matched clip decoding on recorded speech, not measurements of a physical mic, legacy SDL capture or an accelerator.

The merged-checkout verification (`e7d80a3`, same worker SHA-256) also passed with `base.en`: 159/160 relevant checkpoints, with one isolated miss at 40 columns and no consecutive misses. All ten runs passed. Median/p95 latency to the first correct visible pair was 1.457/1.467 s at 80 columns and 1.455/1.460 s at 40. `small.en` passed only 4/5 and 2/5 runs respectively. This confirms the run-level result, not that every displayed word or every checkpoint was correct.

## Before the acoustic-window correction: live drafts still failed during speech

The earlier merged worker (`437fb87`, worker SHA-256 `32293e554d87e53a4622435e7e4e282d83238d00149a0917a8f79bea90b378ef`) was tested on the same four-core i5-7500 with the unchanged corpus and thresholds. No model passed all five sustained-draft runs at both widths. With `base.en`, 5/5 passed at 80 columns and 3/5 at 40; with `small.en`, 3/5 and 2/5 passed. In the first narrow `base.en` run the visible endings “way-release visit to Donald” and “Give me my horse an arm.” both scored 0.67 tail precision, at 16.27 and 18.27 seconds. In the second wide `small.en` run, the drafts were stale at 24.27 and 26.27 seconds. These failures start in decoder output, not in audio capture or editor delivery.

First-correct-draft median/p95 stayed below 3/5 seconds at both widths. Continuous clip → live final WER was 53.57% → 8.93% (`base.en`) and 51.79% → 6.25% (`small.en`). Both now transcribe the JFK and mid-phrase pause controls with 0% final WER; no rollover duplicated a boundary phrase. The smaller weight preserved the deliberate repetition; `small.en` omitted it in both clip and live. All 41 live runs preserved the matched PCM and met the delivery checks; silence and recorded noise produced no words or ASR calls. These improvements do not fix sustained draft relevance. This was paced public audio, not a microphone or matched legacy SDL run.

## Earlier merged-checkout recheck: final year formatting

Rebuilt the CPU worker from `57178a0` and reran the full matrix with the fixture accepting either `1863` or `eighteen sixty three` **only** for the continuous final keyword check. Both forms require the same ordered onset `but now it`. The scorer regression rejects a missing, wrong or out-of-order year and a missing onset. The PCM, timed word reference, visible-relevance scorer and WER calculation and thresholds are unchanged.

All 20 continuous finals passed the corrected keyword check, ending in `June 13, 1863`. Continuous final WER was 8.93% for `base.en` and 6.25% for `small.en`, and both had 0% JFK live WER. Neither passed the combined gate. At 80/40 columns, visible relevance passed 3/5 and 4/5 for `base.en` and 0/5 and 0/5 for `small.en` on this rerun; the four-CPU host was contended (load average 12.60 during the matrix). Both still failed the independent mid-phrase pause keyword check (`seem` became `Seemed`/`seemed`). Accepting equivalent final-year formatting does not fix those recognition or freshness failures.

## Original reference run: host and build

The historical results below were measured 2026-11-25 at Micme `561701a`, before the decoder repairs and the final-year check correction. The archived [runs.jsonl](runs.jsonl) is unchanged.

Linux x86_64 `7.0.0-44-generic`, Intel Core i5-7500 at 3.40 GHz, four logical/available CPUs, 14.7 GiB RAM, no cgroup CPU quota, Node v24.22.3, FFmpeg 6.1.1. Both Release binaries use whisper.cpp `96ec4d9823e9d0211944172da35f9f29134af990` (v1.9.6 pin), CMake 3.31.10 and GCC 13.3.0. Native ggml CPU and OpenMP enabled; BLAS, CUDA, Vulkan and Metal disabled. Clip explicitly uses four CPU threads; the worker uses four for Whisper and one for Silero. The worker uses greedy `best_of=1`, no temperature fallback, no ASR context carry, an audio-dependent encoder window, 512-sample Silero frames, two-frame onset, 0.5/0.35 VAD thresholds, 500 ms release and 20 s rollover. Translation off in every run (`en` for English, `fr` for French).

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `micme-live` | 2,569,296 | `3e7bba0fd12801fff3b31062effac9a3c62289c9a51c009e4fcc2c9d19543446` |
| `whisper-cli` | 3,297,536 | `c0736c2b453f0c060b4f635fa7684e6bbe7ffaa8693ff65b4670fbabe4cca7a0` |
| `ggml-base.en.bin` | 147,964,211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| `ggml-small.en.bin` | 487,614,201 | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
| `ggml-base.bin` (French control only) | 147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `ggml-silero-v5.1.2.bin` | 885,098 | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |

The input is a paced, growing WAV from fixed public audio, not a physical microphone. For the continuous case, the clip receives the exact same 580,640 samples as the worker; the timed speech has a 270 ms onset and lasts 35.000 s. The corpus provenance, edit operations, and how to recreate it are in the [recipe](README.md#corpus-attribution-and-frozen-reference). Each activation loads a new worker/model. The kernel page cache was not cleared; `loadMs` measures the native load, not a cold-disk benchmark.

## Original measured outcome: neither English configuration passed

The reference run exited **1**, with 20 timed continuous runs, 18 other English runs, two separate refinement runs, and one French run. Neither model met the combined native gates. Both passed first-correct-preview latency and showed multiple changing, relevant prefixes before any final. Neither passed the independent sustained visible-relevance gate. There was no capture/ACK, editor delivery, silence or synthetic-overload coverage failure. A second full matrix reproduced the pilot's decisive `base.en` JFK failure and `small.en` freshness failure without changing the corpus or numeric gates. Rollover ownership was checked on the recorded raw finals.

### Visible relevance and responsiveness (separate gates)

Each run has 16 checkpoints. A run with 13/16 hits can still fail if two misses are consecutive. In [runs.jsonl](runs.jsonl) each run records all displayed lines actually sampled, their reference boundary and the full/tail precision and freshness scores (320 checkpoints in all), alongside the actual first two-word latency and timestamped raw worker events.

| Weight / width | Hits out of 16 in run order | Runs passing relevance (need 5/5) | First correct preview, seconds in run order | Median / p95 (need ≤3 / ≤5 s) |
| --- | --- | ---: | --- | ---: |
| `base.en`, 80 | 16, 10, 15, 15, 10 | 3/5 | 1.349, 1.458, 1.451, 1.332, 1.332 | 1.349 / 1.458 |
| `base.en`, 40 | 13, 8, 14, 15, 14 | 3/5 | 1.583, 1.452, 1.945, 1.331, 1.688 | 1.583 / 1.945 |
| `small.en`, 80 | 10, 10, 11, 8, 6 | 0/5 | 1.838, 1.818, 1.820, 1.808, 1.925 | 1.820 / 1.925 |
| `small.en`, 40 | 13, 8, 11, 11, 9 | 0/5 | 1.809, 2.774, 1.807, 1.814, 1.817 | 1.814 / 2.774 |

Example checkpoint output (full timeline in the record):

```bash
jq -r 'select(.kind=="live" and .model=="small.en" and .case=="continuous" and .width==80 and .repeat==1) |
  .visibleRelevance.checkpoints[] | [.atMs, .lastSpoken.word, .visible, .precision, .tailPrecision, .recentTailMatch, .pass] | @tsv' test/live-native/runs.jsonl
```

### Final recognition and controls

Numbers are WER in percent, **clip → live**, unless marked as words/presence. The raw text, reference and edit counts are saved, not inferred from draft scores. The matched clip baseline is useful, not an oracle: it dropped a long stretch of the stitched continuous source with both weights.

| Case | `base.en` | `small.en` |
| --- | --- | --- |
| JFK | 0 → **331.82** (2 substitutions, 71 insertions) | 0 → 0 |
| Continuous | 53.57 → 9.82, identical final WER across 10 runs | 51.79 → 10.71, identical final WER across 10 runs; all 10 repeat a phrase at rollover |
| Real “Thank you”; −18 dB speech | 0 → 0 on both | 0 → 0 on both |
| Mid-phrase pause | 0 → 11.11 (`seem` → `Seemed`, continuation and tail present) | 0 → 0 |
| Real words repeated by editing the source | 0 → 0; both “but now” pairs kept | 18.18 → 18.18; both modes omit the first pair |
| 10 s digital silence | Clip `you`; live no visible, committed, replayed or sent words; 0 ASR calls | Same |
| 10 s recorded rain/transient | Clip `(water splashing) (water splashing)`; live no words or ASR calls | Clip `[applause]`; live no words or ASR calls |
| Immediate stop (320 samples) | Neither writes words; 0 live ASR calls | Same |
| Delayed first feed (JFK) | 0 → 331.82; all PCM preserved | 0 → 0; all PCM preserved |

Both live continuous transcripts reached the date at the end (rendered `June 13, 1863`); digit rendering differs from the predeclared literal keyword sequence `eighteen sixty three` and is not evidence of a lost tail. The historical record retains the original literal keyword gate; the merged-checkout recheck above isolates the equivalent numeric form. Supplemental French with multilingual `base` and `fr` gave clip `Marie.` (100% WER), live `Paris` (0%); this is one same-language control, not general multilingual evidence. Optional JFK refinement reached 0% WER for both, with 3.25 s (`base.en`) or 6.52 s (`small.en`) stop-to-return wall time. It does not repair text already shown or committed during streaming.

### Coverage, load and stop latency

Every run matched the baseline PCM SHA-256 and exact sample count, including the partial last block. `ready` reported one ASR and one VAD load; the wire ledger never had more than one unacknowledged request. The continuous case scanned 1,135 VAD frames per run. The 2.4 s artificially delayed first feed provoked 4/3 catch-up feeds (`base.en`/`small.en`) and peak sample lag of 38,400/38,720, yet both cleanly acknowledged and finalized all 176,000 samples. Continuous recorder pacing delay never exceeded 33.3 ms in the reference runs.

| Continuous, both widths | `base.en` | `small.en` |
| --- | ---: | ---: |
| Native model load (ms); command to activation (ms) | 109.6–130.0; 300.2–365.9 | 265.6–303.2; 453.0–557.3 |
| First editor commit after capture start | 21.82–29.02 s | 24.48–29.51 s |
| Last PCM → worker done; stop → command return | 0.62–2.68 s; 0.65–2.74 s | 2.95–21.70 s; 2.99–21.76 s |
| ASR calls; ASR wall time / audio time (aim <1) | 14–35; 0.70–0.98 | 12–19; 1.01–1.52 |
| Peak coverage lag; peak observed worker RSS | 142,080 samples (8.88 s); 236 MiB | 147,840 samples (9.24 s); 627 MiB |
| Matched clip wall time including load, continuous / JFK | 4.24 / 1.51 s | 12.56 / 4.82 s |

### First divergences and repair owner

1. **`base.en` JFK changes valid speech to repeated nonsense inside the native decoder.** In the reference run the first irrevocable divergence was a raw Worker v1 `final` at 6,202.59 ms for samples `[49248, 72320)`: 73 standalone `S` tokens in place of “ask not.” The matched clip transcript is exact. The final sample count and payload digest match, and those tokens were present before the UI or editor handled the text. This also reproduces under synthetic overload. Task 2 (the resident decoder in `native/live/decoder.cpp`) owns endpoint recognition/selection; inspect the gated span and decoding parameters rather than changing clipping or treating its final as acceptable. The measurements do not isolate which parameter causes the degeneration.
2. **`small.en` gets behind the speaker despite a good first draft.** In continuous 80-column run 1, the 18,927.88 ms preview-enabled feed was not acknowledged until 22,834.57 ms. The raw result covered samples only through 302,592 (18.912 s audio), and the widget showed that result at 22,930.07 ms. At the 22,270 and 24,270 ms checkpoints the visible tail had no recent match, even with ordered precision around 0.91 and 1.00. This puts the first sustained freshness failure before rendering, in Worker v1 decode scheduling/cost. Task 2 owns bounding preview latency while keeping complete PCM; do not remove the post-clipping freshness gate or count first latency/final WER as a substitute.
3. **`small.en` also repeats text across the continuous rollover.** The first final ends “wait for me here. I will go in”; the next one starts “here, I will go in quest…”. That five-word sequence occurs once in the reference, yet the adjacent raw worker finals both own it in 10/10 runs. Task 2 owns the rollover/timestamp repair; do not remove genuine spoken repetitions such as the separate “but now, but now” control.

`base.en` is faster and uses less memory, but its endpoint failure rules out a default switch. `small.en` gives an exact JFK final but cannot keep the draft on recent speech on this CPU. Keep the model default unchanged, repair native recognition, preview pacing and rollover ownership, and repeat the same matrices and thresholds before claiming usable streaming. Clip mode is an interim option if live feedback is not needed; these results do not make its output uniformly reliable either.

## Executed legacy regressions (stdout replay, not matched SDL audio)

Ran [legacy-replay.mjs](legacy-replay.mjs) against baseline `f31e3680215b1f10fd262f1ed4db58324b866404` using the real legacy extension, parser, owned-process stop, and `/micme last`. The fake `whisper-stream` emits exact upstream-style line clears (`ESC[2K CR`, 100 spaces, `ESC[2K CR`), with no ASR. [Raw frames and outcomes](legacy-runs.jsonl) record the bytes, classifications, editor writes and replay. The expected baseline observations were confirmed in all five cases; two violate the desired behavior.

| Fixture | Legacy behavior before stop | Legacy editor and saved result at stop |
| --- | --- | --- |
| One group: “The ocean is blue” → “Please open system settings” | Disjoint revision classified as `incremental`; the discarded first guess is already in the editor | `The ocean is blue Please open system settings` — four inserted words vs the intended final |
| ANSI-only silence on an empty stream | Cleared terminal line classified as `ignored` | Empty; nothing saved or sent |
| Literal `[BLANK_AUDIO]` on an empty stream | Classified as `reset` | Empty; nothing saved or sent |
| “The ocean is blue” then ANSI-only silence | Empty redraw is `ignored`; the four-word candidate survives without an editor write | `The ocean is blue`; stop promotes the guess and `/micme last` pastes it |
| “The ocean is blue” then literal `[BLANK_AUDIO]` | Literal sentinel resets the pending candidate | Empty; nothing saved or sent |

This confirms the difference between an empty ANSI redraw and a literal sentinel at the parser/lifecycle boundary. It does not reproduce model output on the original SDL audio path. The current Worker v1 path does not parse either legacy frame; its silence, short-speech and during-speech controls are measured separately above.

## Boundaries of the evidence

- Deterministic scorer tests check a growing correct prefix with eleven unrelated trailing words (fails despite 2 s first preview and perfect final), a tolerated isolated correction, no look-ahead, optimal-tail freshness, visible progress through clipping, and word error accounting. These are not recognition measurements.
- The timed matrix drives Micme lifecycle, POSIX verified live capture, resolver, real worker, and post-clipping Pi view. The widget observer does not replace ASR or use screen scrape timing.
- Journey: `pi -e .` (Pi 1.6.0) — with an existing editor prompt, started a public WAV replay with Alt+M and saw `Live: But now it doesn't…` grow before a pause. Resized from 80 to 40 columns, saw narrower drafts and resumed JFK words, stopped and saw the draft clear, then cleared the editor and recovered the saved text with `/micme last` (visible on the next cursor movement). The replay also showed the repeated JFK tokens; no provider login or submission was required. This is an interaction check, not another timing sample.
- No physical mic was available to this process (Pulse could not list sources; ALSA exposed no capture source and `hw:0,0` failed to open). No private audio was recorded. No matched legacy SDL/loopback run, native Windows run or hardware-accelerated benchmark. The legacy parser replay measures text handling, not recognition on the original SDL audio. These numbers are matched **current live vs current clip**, not before/after legacy benchmarks.

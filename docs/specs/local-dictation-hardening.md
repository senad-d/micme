# Measuring live recognition and latency

Kind: hardening

## Purpose and scope

Assess whether local models produce the right words **before** the speaker pauses, at what cost and on which hardware. Use two separate proofs: deterministic application/transport behavior and a paced native speech experiment. A mock printing the reference perfectly proves nothing about Whisper's accuracy.

## Baseline

| Measured or found | How | When | Result |
| --- | --- | --- | --- |
| Decode requests | `src/constants.ts` and pinned [upstream loop](../research/local-dictation.md#what-whisper-stream-actually-supplies) | 0.4.1 baseline | Nominal 1/s runtime vs 2/s settings profile, even during silence. These are source-derived rates, not stopwatch measurements. |
| Correction accuracy | [Two-rewrite source trace](../research/local-dictation.md#replaying-a-correction) | Same checkout | 4 inserted words on 4 reference words, not an acoustic WER measurement. |
| Active configuration and startup | Running checkout, documented `pi -e .`, [TUI observations](../research/local-dictation.md#evidence-from-the-running-app) | Same investigation | Observed 0.45 VAD slider, capture −1, separate Audio microphone. Native stream reported missing binary. Active UI exercised with fixtures only. |
| Native timing and accuracy | No native ASR/VAD model execution in planning environment | Before implementation | Unverified: no WER, real-time factor, first-word latency or evidence that a larger model fixes this microphone. |

## Target

| Measure or rule | Today | Target | Check that decides it |
| --- | --- | --- | --- |
| Silence/noise | Source: ungated windows; no measured false-word rate | Zero visible or delivered words on 10 s digital silence and recorded nonspeech controls; zero ASR calls on digital silence | Pace at 1×; score partials as well as final/paste/send. Report noise false positives separately. |
| Positive speech | Static false-commit case; native quality unknown | Correct multiword preview before stop and before the first endpoint in continuous speech; nonempty final on short/quiet spoken controls. No lost onset/tail or extra duplicate rollover. | Timestamp preview vs **audio** ground truth. Track normalized keyword order and WER, not just “any output”. |
| Live responsiveness | No measured baseline | Engineering gate on declared reference host with a suitable tested weight: median onset → first correct ≥2-word preview ≤3 s, p95 ≤5 s; multiple updated correct prefixes in ≥30 s continuous speech. | Pace real PCM in real time, ≥5 runs per measured configuration. Separate cold model load, onset, endpoint and stop-to-final; report actual values even on a miss. |
| Visible draft relevance | No native baseline; a timely correct prefix can hide an unrelated suffix | Pass the checkpoint rule in Proof on the continuous-speech fixture at both declared display widths. Gate the words actually visible while speaking, independently of first-word latency and final WER. | Score the displayed line against timed reference words already spoken. Empty output and persistent unrelated tails fail; an isolated correction may pass the run. |
| Native accuracy and load | No measured baseline | Same-language JFK/reference final WER ≤20% and no more than 10 percentage points worse than matched clip; no silent skipping to hit latency. Aim ASR compute/audio ratio <1 on reference configuration. | Score (substitutions + deletions + insertions)/reference words, case/punctuation normalized; also show raw text and sample counts. Empty transcript on speech fails. |
| Overload | Upstream live source has finite history | One model load per recording and ≤1 in-flight decode; full final sample coverage. Later previews may coalesce but a slow decoder cannot drop captured speech. | Slow fixture plus native paced run. Record max sample lag and final drain time; final acknowledged sample count equals input count. |

These are delivery targets, **not** observed performance. Before running, declare the reference host, `base.en` and `small.en` configurations and display widths. At least one and the same configuration must pass visible relevance, responsiveness, speech/silence, coverage and final accuracy. If none passes, Task 7 reports a failed delivery gate, not a completed quality improvement. Route the first observed divergence to its owning task (capture: 3; gated decoder output: 2; transport/ordering: 5; displayed text: 6; scorer/fixture: 7) and repeat unchanged inputs and thresholds after repair.

## Findings

| Id | Rank | Area | Where | What is wrong | Cost or exposure | Certainty |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | 1 | time | `src/streaming.ts:buildWhisperStreamCommand`; `src/config.ts:getTranscriptionModeProfile` | Short positive steps run ASR on nonspeech; TUI doubles nominal frequency without activating VAD. | Wasted inference, misleading tuning and possible unrelated words | Source verified; time saved unmeasured |
| H2 | 2 | time | `src/streaming.ts:scheduleStreamingFlush`, `extractStreamingCandidate` | Measures elapsed time to *any* committed text, even if stale or false. | Faster wrong text can appear to be an improvement | Source verified |
| H3 | 3 | memory | `src/extension.ts:startStreamingTranscription`; upstream SDL buffer | Optional second device read; simple polling cannot show coverage when slow. | Unmatched inputs; a seemingly fast stream can omit speech | Separate ownership verified; device/overload loss on user's machine unknown |

## Fix per finding

| Id | Change | What it could break | Finding it must not reopen |
| --- | --- | --- |
| H1 | Use one resident decoder, acoustic gate and coalesced partial decodes. Instrument per-op model-load, VAD and ASR counts/times for the opt-in run. | A gate can reject quiet or brief speech; more compute can improve WER at a latency cost. | H2: require correctness of the first visible words. |
| H2 | Evaluate live hypotheses separately from endpoint finals using paced audio + references. Fix commit policy, not just reported latency. | Delaying all output until stop can score a fine final WER. | H1: require live updates during uninterrupted speech. |
| H3 | Persist single capture, consume in bounded blocks and measure capture/read/final counts and lag. | Reading only at stop or eagerly holding entire sessions in RAM. | H1: keep one request in flight; H2: prove visible, not just buffered, updates. |

## Proof

| Id | Check that shows it is fixed | Measurement to repeat |
| --- | --- | --- |
| H1 | Native, real-time replay with the same pinned PCM, language and model in clip and live. Inspect calls, audio counts, warm decode time and idle periods. | Baseline clip with whisper-cli, then live with `small.en` and `base.en` on the same build/hardware (CPU first, acceleration only if observed). Keep reference and clip output separate. |
| H2 | Timestamp the actual consumer's first correct two-word sequence in the current utterance and several changed previews in sufficiently long uninterrupted speech. Score visible relevance at the predeclared checkpoints below; report it separately from latency and final WER. | ≥5 runs/config; include warm/cold startup separately, first correct draft, first committed text, last PCM → final; median/p95 (nearest rank), individual values, final text and edit counts. |
| H3 | Pace the same file through the configured recorder at 1× including the last partial block. Account for every sample through done; on artificial slowdown verify that only intermediate previews coalesce. | Record captured/processed totals, peak lag, ASR wall-ms/audio-ms, model loads/decodes, peak RSS where available. Show inputs, device, OS/CPU, actual acceleration/threads if known, build and weight identifiers, language, VAD/ASR settings. |

For the ≥30 s continuous fixture, timestamp reference word ends once, before decoding. At 4, 6, 8, … seconds after speech onset, strictly before speech ends, sample what the widget **already displays** at 80 and 40 columns (including any clipped tail). Do not select the best update, wait for an endpoint, grade hidden text or use future words. Strip only the `Live:` label, ellipsis and styling; case-fold and tokenize whole words like the reference. A missing draft or fewer than two visible whole words misses the checkpoint.

Let D be those displayed words and R the reference words spoken by that checkpoint. Score both D and its last eight words (or all if shorter): ordered matches = length of their longest common subsequence with R; precision = matches / words scored. Pass a checkpoint only if **both precisions ≥0.75** and an optimal tail alignment matches at least one word ending in the preceding 5 s. This permits revisions and left clipping without rewarding a stale prefix. At each width in each of five runs require ≥80% passing checkpoints and no two consecutive misses. Save timestamp, R boundary, actual visible D and scores. Keep the separate requirement for changing correct prefixes; a motionless label isn't progress.

Unit-check the scorer with three checkpoints whose correct prefixes grow from two to four words, each followed by the same eleven words absent from R. Full precision starts at 2/13, tail precision is zero throughout; the fixture must fail even with 2 s first-correct latency and 0% final WER. Include a passing trace with an isolated corrected miss. These are logical scoring fixtures, not native results.

Use public pinned JFK audio with human reference, a fixed continuous-speech case ≥30 s (can construct from documented speech excerpts without silence at joins), digital silence, a nonspeech noise control, short “Okay”/“thank you”, quiet speech, a mid-phrase pause, immediate start/stop and repeated words. Predeclare transcripts/keyword order and speech intervals. Add a multilingual check with compatible weights; don't grade a translation against a same-language reference. Use a consented local sentence if a physical mic is available; do not publish private recordings.

Native execution is opt-in; model/binary discovery must not download or run anything in normal unit CI. Explicit evaluation must fail/report an unmet prerequisite, not silently skip. Emit a reproducible results record including unavailable cases and failures. If the legacy SDL binary and loopback are available, replay the same waveform and collect a genuine before/after; otherwise label original live results source-only and compare new native live to matched native clip. No estimates substituted for timings.

## Accepted

None.

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Model defaults | Retain current ASR choice; test base.en for speed and small.en for quality, mention quantization as a separate explicit local-file experiment. | Silent switch to a larger/quantized model or claiming published accelerator speeds | File size does not measure end-to-end behavior. Named translation models must remain translate-capable. |
| Comparison | Evaluate correctness on the same signal first, speed second. Seed fixed data; isolate OS mic routing in a separate smoke run. | Comparing two live mics, or a synthetic stream that emits canned words | Controls the acoustic input while preserving real native inference. |

## Open questions

| Question | Who can answer | What waits for it |
| --- | --- | --- |
| Unverified: native WER, load time, correct-first-preview latency, compute ratio, and the best weight on the available hardware? | The explicit native evaluation with labeled local model/build/hardware | A quantified performance or quality claim. No substitute estimate from fixture timing. |
| Unverified: actual user's input health, noise and acceleration? | Optional matched-device smoke run | Only claims about that user's particular setup. |

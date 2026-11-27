# P4 optional recognizer: public replay evidence

These are isolated real Pi takes, not the component smoke or the existing Whisper Worker v1 proof. The opt-in collector dispatches the normal Micme shortcut with the exact selected model installed in a private directory, a growing paced public WAV in place of a physical microphone, auto-submit disabled, and external network access denied by the Pi supervisor. It joins real native events, actual engine binding, recorder close, editor readback and the rendered PTY on one clock. At narrow widths the prompt can scroll: full editor readback is joined with only the visible PTY tail, not described as a fully visible prompt. Native end-of-stream events precede editor commits; batch does not claim speculative drafts or streaming ACKs. All inputs are the unchanged public P1 PCM hashes and references.

## Replay and regrade

Provision the pinned public assets and private sidecar using [the native verification instructions](README.md#optional-recognizer-qualification). The helper SHA-256 is `75f3202cf290f69973a5e23cf64cb761bbdefd859d24cf0d21a33442d2a3005a`; its source, build and weight notices are in the [optional native guide](../../native/recognizer/README.md). The published runs bind the actual Linux x86-64 Intel Core i5-7500 CPU label; the helper supplies no stable CPU device ID. Other platforms/devices are not qualified by these observations.

```bash
npm run test:live-native -- --transfer-engine "$MANIFEST" 'moonshine-streaming-tiny/Q8_0@3b75b3ab1d29bee2112deb73514de0657337db559134956af809d3dd70231174' "$WORK/streamer.jsonl"
npm run test:live-native -- --transfer-engine "$MANIFEST" 'parakeet-tdt-0.6b-v3/Q4_K_M@536c7023afb9030c8e6f4d238607c7dc5d9b5b27361a79e8ff4139321822cab4' "$WORK/batch.jsonl"
```

Use fresh output names. Each invocation also writes a `.receipts.json` file with the product source receipt, manifest hash, separate matched whole-file results, native gate projections and recovery observations. The [common reporter](transfer-report.mjs) regrades the B takes directly; the receipts are not a substitute for `scoreTake`. [P4 scorecard input](transfer-q-p4.jsonl) links the measured gates and outstanding cells. The native gate attempts and recovery attempts are separate; a deliberately failed initial take is not a successful first decode just because the verified retry later delivered.

## What these runs establish

- Both exact weights recognized the same public JFK waveform through normal Pi dictation on CPU with zero word errors and recorded zero ASR calls on digital silence. Parakeet produced no speculative transcript. Its continuous take split at samples 486,720 and 580,640 (30.42 and 36.29 seconds), covering the same full input without overlap and returning 3.57% raw WER at both widths.
- Moonshine passed the continuous preview gate at both widths in the [earlier run](transfer-q-p4-streamer.jsonl): 14/16 (40 columns) and 15/16 (80 columns), without consecutive misses. The [preceding pass](transfer-q-p4-streamer-rechecked.jsonl) hit 13/16 and 16/16 ([receipt](transfer-q-p4-streamer-rechecked-receipts.json)). The gate was **not consistent** in the [earlier repeat](transfer-q-p4-streamer-repeat.jsonl), which hit 12/16 and 6/16. All three had 8.93% raw WER, exact PCM, ordered ACKs and the correct once-only target. The earlier [merged trace](transfer-q-p4-streamer-merged.jsonl) remains separate historical evidence.
- The [repeat receipt](transfer-q-p4-streamer-repeat-receipts.json) records provisional hypotheses before clipping, separately from the scored PTY. Diagnostic regrading of the uncut hypotheses hit 16/16 at 40 columns, where clipped suffixes exposed errors such as “I will go and question.” instead of “I will go in quest of this knight.” At 80 columns the uncut hypotheses also missed (8/16); that take had 336,480 samples of lag at the recorder’s last write, versus 31,200 in the latest passing 80-column take. Lag at the last write is not peak lag. These observations do not isolate a rendering defect or establish an exact load threshold.
- Held-model reuse, explicit unload/reload, and staged recorder close are separate observations. Recovery takes force a kill or an unresponsive worker after capture reaches the end. All four fault trials offered a same-model retry for verified audio, recovered the original JFK PCM hash, and mutated the Pi prompt once with no sends or queues. Their sibling next takes used a fresh worker. The receipts preserve the verified PCM digest, actual binding, counters, outcome and observed mutations.
- Controlled overload pauses only the owned worker while recording continues. Moonshine records catch-up feeds, ordered real ACKs and the complete PCM. A backlog-sized feed advances the real decoder but withholds its intermediary draft. The latest withheld revision remains eligible for the next fresh ACK even if the engine does not send the same words twice.
- This is functional evidence, not latency parity: there are not 20 matched, calibrated pairs per condition. Several speech controls lack frozen acoustic alignment; Parakeet's 20 ms negative had no observed ready cue. Their corresponding gates stay unverified even when other observations pass. Physical microphones, accelerators, other variants, and an independently induced product-level native returned error remain unverified.

### Replay after integration

The replay on the merged source recorded 17 takes each for [Moonshine](transfer-q-p4-synced-streamer.jsonl) and [Parakeet](transfer-q-p4-synced-batch.jsonl) ([streamer receipts](transfer-q-p4-synced-streamer-receipts.json), [batch receipts](transfer-q-p4-synced-batch-receipts.json)). Both again consumed exactly 580,640 samples on continuous speech, delivered once at each width, and made zero ASR calls on digital silence. Parakeet passed the continuous gates at both widths, with the same 486,720-sample cut and 3.57% raw WER. The immediate negative passed on both routes in this replay.

Moonshine again produced 8.93% raw WER and ordered ACKs, but missed the clipped-preview gate at both widths: 5/16 and 6/16 relevant checkpoints. One-minute host load at trigger was 6.72 and 5.89, with 291,680 and 417,760 samples still unacknowledged at the respective recorder's last write. The earlier passing replay does not establish consistent preview, and the host load observations do not prove its cause.

The four process-fault trials again recovered the exact 176,000-sample JFK input with one observed prompt mutation each, no sends or queues, and a fresh worker on the next take. This establishes kill/hang recovery, not a product-level returned-error or Auto fallback from an accelerator to CPU.

### Residency and trigger-to-load observations

JFK from the merged-source replay, one run per cache condition. Load latency is measured from the Pi toggle and includes selection/preflight. Peak RSS is the worker’s process high-water mark (warm can include the prior take). Idle RSS is a resident-worker sample after reset; all six takes logged recorder close, not physical microphone state.

| Model | Cache | ASR loads | Trigger → load | Peak RSS | Idle RSS |
| --- | --- | ---: | ---: | ---: | ---: |
| Moonshine | cold process | 1 | 1,099 ms | 162.8 MiB | 65.1 MiB |
| Moonshine | warm model | 0 | 325 ms | 162.8 MiB | 81.1 MiB |
| Moonshine | after explicit unload | 1 | 886 ms | 170.8 MiB | 84.0 MiB |
| Parakeet | cold process | 1 | 5,053 ms | 904.7 MiB | 860.0 MiB |
| Parakeet | warm model | 0 | 1,527 ms | 908.6 MiB | 863.9 MiB |
| Parakeet | after explicit unload | 1 | 4,625 ms | 904.1 MiB | 859.4 MiB |

### Separate Worker v1 check

The pinned Whisper worker passed its three protocol smoke tests. With the synced harness (which now supplies a session manager), the independent positional quality runner passed on the pinned audio, weights and VAD. All 39 live attempts reached exact coverage. `base.en` passed the English gates at both widths: 15–16/16 relevant checkpoints in every continuous take, first-useful median/p95 1.45/1.46 s at 40 columns and 1.46/1.69 s at 80 columns. Its JFK clip refinement and the multilingual `base` French control passed. `small.en` did not meet sustained preview at either width; the positional gate requires one qualifying English configuration, not both. The historical Worker v1 report remains unchanged and no optional-engine take substitutes for it.

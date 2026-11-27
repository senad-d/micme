# Opt-in native dictation evaluation

These evaluations are opt-in, not part of normal `npm test`, package checks or installation. The positional runner below is the original Task 7 Whisper/Silero experiment; see its [reference-host results](results.md) and [unchanged quality gates](../../docs/specs/local-dictation-hardening.md#proof). For the four-product comparison and its separate evidence, start at [Handy transfer: P1 baseline](#handy-transfer-p1-baseline). Neither needs a physical microphone, Pi login or network after provisioning.

## Provision once

Use a POSIX host with the checkout's Node version (`npm ci`), FFmpeg, `curl`, `jq`, and the C/C++/CMake toolchain in the [worker guide](../../native/live/README.md). Put work, data and builds outside the checkout. Start with the pinned upstream archive from that guide (including its archive checksum check). Build both binaries from that exact source, CPU only. For example, from the Micme checkout with `WORK` set to a scratch directory and `SOURCE` set to the extracted upstream source:

```bash
cmake -S native/live -B "$WORK/worker" -DCMAKE_BUILD_TYPE=Release \
  -DFETCHCONTENT_SOURCE_DIR_WHISPERCPP="$SOURCE" -DGGML_METAL=OFF
cmake --build "$WORK/worker" --parallel 2
cmake -S "$SOURCE" -B "$WORK/clip" -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  -DGGML_METAL=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build "$WORK/clip" --target whisper-cli --parallel 2
WORKER="$WORK/worker/micme-live"
CLIP="$WORK/clip/bin/whisper-cli"
"$WORKER" --protocol-version  # exactly 1 + newline
```

Use separate local English weights and a multilingual weight. The default task comparison does not change Micme settings or recommendations. The runner records every file's identity, so a weight change is visible in the result rather than a silent retune.

```bash
ASSETS="$WORK/assets"
mkdir -p "$ASSETS"
cp "$SOURCE/samples/jfk.wav" "$ASSETS/jfk.wav"
for WEIGHT in base.en small.en base; do
  curl -fLsS "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-$WEIGHT.bin?download=true" -o "$ASSETS/ggml-$WEIGHT.bin"
done
curl -fLsS https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin -o "$ASSETS/ggml-silero-v5.1.2.bin"
curl -fLsS https://raw.githubusercontent.com/karolpiczak/ESC-50/f2fd956acf66ebd9ac7e2110711aa78dd684d042/audio/1-17367-A-10.wav -o "$ASSETS/rain.wav"
curl -fLsS https://upload.wikimedia.org/wikipedia/commons/b/bc/En-us-thank_you_1.ogg -o "$ASSETS/thanks.ogg"
curl -fLsS https://upload.wikimedia.org/wikipedia/commons/f/fd/Paris_Pronunciation_in_French_by_James_Tamim.ogg -o "$ASSETS/paris.ogg"
```

Take just the named LibriSpeech utterances. The dataset server URLs expire; request new URLs with the **same** pinned data revision. The recipe verifies the row IDs and revision in the audio URLs. The runner verifies source SHA-256 before preparing any audio. Do not substitute different rows if the server changes (the recording IDs are also under OpenSLR LibriSpeech dev-clean; the exact fixture hashes are in [corpus.mjs](corpus.mjs)).

```bash
curl -fLsS 'https://datasets-server.huggingface.co/rows?dataset=gilkeyio%2Flibrispeech-alignments&config=default&split=dev_clean&offset=0&length=14' -o "$WORK/rows.json"
set -o pipefail
jq -r '.[] | [.row,.id] | @tsv' test/live-native/alignment.json | while read -r ROW ID; do
  URL=$(jq -er --argjson row "$ROW" --arg id "$ID" '
    .rows[] | select(.row_idx == $row and .row.id == $id) | .row.audio[0].src |
    select(contains("/0daa1eb43dda38ee6ce752e785555380e5628f5c/"))' "$WORK/rows.json") || exit 1
  curl -fLsS "$URL" -o "$ASSETS/$ID.flac" || exit 1
done
```

## Corpus, attribution and frozen reference

No private recordings or audio files are checked in. The recordings are local copies of these public sources:

- JFK: U.S. presidential inaugural address (public domain), the unedited 11 s `samples/jfk.wav` from the pinned whisper.cpp release. Human reference: “And so my fellow Americans, ask not what your country can do for you; ask what you can do for your country.” This entire source excerpt is the JFK evaluation interval. Overload reuses it byte-for-byte.
- Continuous, quiet, pause and repeat: [LibriSpeech](https://www.openslr.org/12/) dev-clean public-domain LibriVox readings, distributed with [Montreal Forced Aligner timings](https://huggingface.co/datasets/gilkeyio/librispeech-alignments/tree/0daa1eb43dda38ee6ce752e785555380e5628f5c) by gilkeyio (CC BY 4.0). [alignment.json](alignment.json) preserves the five IDs, transcripts and word spans selected before any evaluation decode; in row 13 only, it restores human-reference `rangitata` for MFA's `<unk>` interval. The prepared continuous case joins these readings in that order, preserving internal timing and keeping 20 ms either side of each utterance (at most 40 ms of padding at joins). With 250 ms lead-in, the first word starts at 270 ms; the final word ends at 35,270 ms. `quiet` uses the first excerpt at −18 dB (speech interval 270–2,980 ms); `pause` inserts 1,050 ms at the “doesn't / seem” boundary (speech intervals 270–1,370 and 2,420–4,030 ms); `repeat` prepends its recorded “but now” (speech interval 270–3,620 ms). Final keyword sequences and full references are declared in [corpus.mjs](corpus.mjs).
- Short: [“Thank you” by Mx. Granger](https://commons.wikimedia.org/wiki/File:En-us-thank_you_1.ogg) (CC0), unedited speech with zero padding (roughly 161–973 ms). French: [“Paris” by James Tamim](https://commons.wikimedia.org/wiki/File:Paris_Pronunciation_in_French_by_James_Tamim.ogg) (CC BY-SA 4.0), same-language recognition with the non-English-only `base` weight, not translation (roughly 252–757 ms). Both files are converted to mono 16 kHz and padded, not resynthesized.
- Negative controls: 10 s digital silence, two copies of [“unlocki door to mod rain.wav” by cognito perceptu](https://freesound.org/s/17367/) (CC0; ESC-50 sample `1-17367-A-10`, recorded nonspeech), and immediate stop after the first 20 ms/320 silent samples. No reference words, or allowable visible/committed words, in any of these cases.

## Run and replay

This positional command is the **Worker v1** native qualification path. It only qualifies the original Whisper route. See [Optional recognizer qualification](#optional-recognizer-qualification) for the separate artifact-selecting path.

```bash
node --test --test-reporter=dot test/live-native/scoring.test.mjs
npm run test:live-native -- "$ASSETS" "$WORKER" "$CLIP" "$WORK/results.json"
```

Run on an idle CPU; the default matrix takes roughly 15–25 minutes, depending on the host. Missing prerequisites and failed gates are nonzero, with a JSON result even on startup failure. Each English configuration runs the 36.29 s aligned case five times **per width**, then the remaining English controls at 80 columns. All use matched clip input and weights, but clip is a separate whole-file `whisper-cli` run (4 CPU threads, same language, no clip VAD); optional refinement is reported separately, never substituted for unrefined live recognition. The French case is supplemental and does not enter the English comparison. Use the same matrix unmodified on a different host. For a weight experiment, repeat with a separate assets directory and clearly label any substituted weight and SHA-256; do not present its results as the pinned reference comparison.

The checked result is written on completion and after each run. Store the output and its raw wire logs if investigating a failure. Paths in the JSON point to a fresh `micme-quality-*` scratch directory under `$TMPDIR`: remove that directory after retaining any evidence you want. Use `--prepare` to generate ordinary WAVs and their declared references/digests without starting Pi or inference:

```bash
npm run test:live-native -- --prepare "$ASSETS" "$WORK/wav"
```

For a real Pi TUI replay, use an isolated `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, and these settings in that directory's `micme.json` (replace paths with simple absolute local paths; quote shell arguments with spaces). The native runner uses the same recorder implementation. Start with `pi -e .`, press Alt+M, and watch `Live:` before the recording has ended. Resize or repeat at 80 and 40 columns; stop, review, and try `/micme last`. Do not submit a coding prompt or enable model downloads/auto-submit for this exercise.

```json
{
  "MICME_TRANSCRIPTION_MODE": "stream",
  "MICME_TRANSCRIBE_BACKEND": "whisper.cpp",
  "MICME_LIVE_BIN": "/path/to/micme-live",
  "MICME_WHISPER_CPP_MODEL": "/path/to/assets/ggml-base.en.bin",
  "MICME_VAD_MODEL": "/path/to/assets/ggml-silero-v5.1.2.bin",
  "MICME_LANGUAGE": "en",
  "MICME_AUTO_DOWNLOAD_MODEL": "0",
  "MICME_AUTO_SUBMIT": "0",
  "MICME_STREAM_DIAGNOSTICS": "1",
  "MICME_RECORD_COMMAND": "exec node /checkout/test/live-native/paced-recorder.mjs {audio} /path/to/wav/continuous.wav /path/to/replay-capture.jsonl"
}
```

## Replay the legacy stdout regressions

For a separate checkout of `f31e3680215b1f10fd262f1ed4db58324b866404`, run its `npm ci`, then run the following from this checkout. No SDL capture source, actual model or provider login is used. Exit 0 means the expected legacy observations reproduced, **not** that the legacy behavior is correct. See the [legacy result](results.md#executed-legacy-regressions-stdout-replay-not-matched-sdl-audio).

```bash
node test/live-native/legacy-replay.mjs "$LEGACY_CHECKOUT" "$WORK/legacy-runs.jsonl"
```

## Interpreting the report

- **Visible relevance**, independent from latency and WER: at each 4 s, 6 s, 8 s… checkpoint from onset, use the most recent real widget write already visible, not the next refresh. Compute ordered precision for the full line and its last eight words against reference words that had **ended**. Require both at least 0.75 and a match in the last five seconds in an optimal tail alignment. Missing/one-word drafts miss. Every run/width needs at least 80% hits and no consecutive misses. Save visible text, the last spoken reference word and both scores per checkpoint.
- **Latency and progression**: the first visible adjacent pair must match two already-spoken adjacent reference words and appear before the first worker final or end of speech, whichever comes first. At least two relevant, advancing visible revisions are required in every continuous run. For a line starting with the clipping ellipsis, compare its visible start against the matching spoken reference span; the point of narrow mode is not to re-display the old beginning. Nearest-rank median ≤3 s and p95 ≤5 s per width; a missing first preview is infinite (`null` in aggregate JSON). Keep model-load time, command-to-activation, first worker partial, first worker final/commit, last-PCM, stop-to-done and stop-to-command-return separate. The first worker load in each operation is always a new process; OS file caching is not forced cold (asset hashes and separate clip run can warm page cache).
- **Final**: normalized substitutions, deletions and insertions are separate from any draft. JFK and the continuous fixture must finish at ≤20% WER and no more than 10 percentage points above matched clip WER; check the predeclared keyword order for onset, tail and repetition, test raw neighboring finals for a repeated boundary phrase not present in the reference, and require usable short/quiet finals. Only the continuous final keyword gate accepts the terminal year `1863` or the contiguous phrase `eighteen sixty three` after the same ordered onset. Words separated by an incorrect year and an unrelated later “three” do not count. This does not change WER tokenization or timed draft scoring. Negative controls scan every visible draft and editor write, with zero ASR calls on digital silence. The WER denominator for a no-reference case is undefined (`null`), not 0%.
- **Coverage and cost**: the runner drives the real Micme extension registration, command, resolver, verified growing-WAV capture, Worker v1 transport and recording widget (TUI-shaped context records the actual post-clipping string arrays). A byte-forwarding observer timestamps actual worker events and checks ordered feed/ack ledger, one frame in flight and SHA-256 of fed PCM vs baseline. An overload replay delays the first feed 2.4 s, requiring catch-up frames and the same complete feed. Compare native load/ASR/VAD counts, ASR wall-time/audio-time (aim <1; not a substitute for accuracy), peak lag and peak worker RSS where available. The Node observer adds a small scheduling/I/O cost; a separate real Pi TUI replay is an interaction check, not the timed matrix. Use raw worker events vs the clocked UI trace to distinguish decoder errors from transport or clipping errors.

## Handy transfer: P1 baseline

Use the frozen `transfer-p1-manifest.json` and generated `transfer-baseline.md` in the public bundle under `test/live-native`. The comparison uses **B**, the V1 protocol and per-take observations, and **Q**, the phase scorecard rows that link to those observations. [Historical Whisper results](results.md) are not P1 results. The [transfer roadmap](../../docs/plans/handy-transfer/roadmap.md#phase-1-comparable-dictation-baseline) describes the comparison's scope.

### Provision the pinned inputs

1. Start on an idle Linux CPU host. Install the checkout's Node dependencies with `npm ci` (Node ≥22.19.0 for this runner). For Pi collection, provide `/usr/bin/python3` and `libseccomp.so.2`; for Handy, run as a non-root user on a host that permits Bubblewrap's user, mount, PID, network and IPC namespaces. Use the Linux release plus its native runtime dependencies and adjoining `../lib/Handy` resources relative to the binary's directory. All Handy collection needs `bwrap`, `Xvfb`, `dbus-daemon` and `dbus-send` in `/usr/bin`; the paced and destination tracks also need `pulseaudio`, `pactl`, `pacat`, `wish` and `xdotool` there. A denied namespace or missing runtime is a gap, not a reason to run unisolated.
2. Use separate installations of Handy `v0.10.2` (`a822741f9c697b6f6a00c557e4817bf59ae70867`), Micme `v0.4.1` (`481e3e30ac6138108341ad41a0579da80a321a3e`), historical Micme `70ad13862563aa46b7bd76411a1df852d9c740b7`, and the current Micme commit named by the manifest. Install each Pi checkout's dependencies from its own lockfile, and supply the manifest-compatible Pi executable explicitly. Build the pinned native binaries per product; use that checkout's pins, not another version's artifacts. [Provision once](#provision-once) has the CPU toolchain and offline-source recipe for this checkout's Worker v1 and its whole-file `whisper-cli` comparator. Record the engine revision, binary and model SHA-256, quantization, VAD and chunk policy. A successful worker version probe is not a build receipt or proof of quality.
3. Acquire the [pinned public source assets](#provision-once), then prepare the comparison WAVs in a different directory. `WORK` and `ASSETS` are the absolute scratch and source asset directories from the original recipe.

   ```bash
   npm run test:live-native -- --transfer-prepare "$ASSETS" "$WORK/transfer-wav"
   ```

   Use that destination as `assetsDir`. Keep `transfer-fixtures.json` with the WAVs: the collector verifies the mono 16 kHz PCM16 payload against the manifest and uses the matching human alignment for timed speech. The [corpus attribution](#corpus-attribution-and-frozen-reference) also applies here. For the optional identifiers, non-Latin and translation controls, pass a third argument, `PUBLIC_SOURCES_JSON`, with the three entries described in [transfer-fixtures.mjs](transfer-fixtures.mjs). Pin the source WAV digest and include attribution, license, reuse permission and human word timings; translation also needs independent meaning review. Without those inputs the controls are explicitly absent. Do not make up audio, timings or references for the frozen comparison.

Allow build time for each native build tree and disk for the sources, dependencies, models and scratch evidence. The three original Whisper weights plus Silero alone take about 750 MiB, before the separate Handy weights and per-take staging copies. Handy stages the selected binary, model and WAV per take; do not put scratch on a filesystem without room for those copies. Fetch dependencies, pinned source archives, tools, public audio and exact model files before going offline. The preparation, collection and report steps do not need downloads or a provider login.

### Keep local paths and app state private

Copy the frozen manifest unchanged to a private scratch directory before supplying local inputs. For example, with `WORK` set to an existing private directory outside the checkout:

```bash
MANIFEST="$WORK/transfer-p1-manifest.json"
cp test/live-native/transfer-p1-manifest.json "$MANIFEST"
```

Beside that copy, create `transfer-local.json`. Use absolute paths, lowercase SHA-256 hex digests, `null` for absent scalar inputs and `[]` for absent lists. This empty sidecar is valid but does not provision a take:

```json
{
  "assetsDir": null,
  "piBinary": null,
  "tagCheckout": null,
  "historicalCheckout": null,
  "currentCheckout": null,
  "backendFiles": [],
  "handyBinary": null,
  "handyModelFiles": [],
  "whisperModelFiles": [],
  "vadFile": null,
  "workDir": null
}
```

- `assetsDir` is the prepared WAV directory; `workDir` is an existing private or sticky directory. Each `backendFiles` entry is `{product, workerFile, clipFile, streamFile, workerSha256, clipSha256, streamSha256}`; use one entry per provisioned product and leave unused files and hashes `null`. Use `{name, file, sha256}` for each Whisper weight. The planned build must pin the actual worker hash for Worker v1 or the actual clip hash for the tag's whole-file PCM slot. Worker v1 needs its own worker, clip comparator and Silero; the stock tag's SDL stream has no isolated observer here. The tag's clip observation is not a substitute for its live path.
- In `workDir`, create `transfer-pi-sources.json`, a JSON object keyed by the provisioned Pi product IDs (`micme-041`, `micme-70ad138`, `micme-current`). Each entry records `{commit, sourceSha256, piSha256, vadSha256}`; `vadSha256` is required for Worker v1. Verify each checkout against the full planned commit before making the receipt. `sourceSha256` covers the package manifest, lockfile and extension source bytes; it is not a Git commit check. Run this from the benchmark checkout with `CHECKOUT` set to each pinned checkout:

  ```bash
  node test/live-native/transfer-pi.mjs --source-sha256 "$CHECKOUT"
  ```

- Use `{catalogId, file, sha256}` for each Handy weight. The planned model filename, digest and installed catalog entry must agree; do not substitute a nearby quantization or revision. The desktop collector verifies bundled Silero when the selected path needs it. Handy PCM runs the installed-model WAV CLI with no gesture or target. Desktop collection requires a private loopback and toggle; the actual destination observer is a controlled editor, not a clipboard timer.

Do not publish the sidecar, local receipts containing private details, raw scratch logs or personal recordings/profile state. Pi uses a disposable home, project and agent profile, a paced WAV recorder instead of a microphone, and a socket guard; provider access is off except for the optional seeded local stand-in. Handy stages the supplied public input and exact model in its own sandbox with a disposable home, config, data, cache, runtime and history. It starts its own X11 display and session bus and, for desktop, PulseAudio loopback and receiver. Let the collectors verify isolation and clean up the state they own. Never reuse a running personal instance, display, audio source, clipboard or editor to fill a gap.

### Replay Pi without sending a prompt

After `npm ci`, launch the isolated public seed. No manifest, weights, backend build, microphone or account is needed:

```bash
npm run test:live-native -- --pi-local
```

In the real Pi terminal, type `PUBLIC BENCHMARK:` without submitting it. Press Alt+M to start, watch the draft change before confirmed text appears, then press Alt+M to stop. Check the prompt at 40 and 80 columns, then use `/micme last` to replay explicitly. If the paste is not yet visible, press Left Arrow to redraw; report the redraw separately from the paste. `/transfer-restart` relaunches the disposable session; `/quit` removes it. Without a TTY, the launcher scripts the two widths, checks the rendered prompt and explicit replay, verifies zero sends/queues and exercises the restart and input guard. These are real editor observations with **scripted ASR**, not native speed or accuracy results.

To replay with a real Worker v1 instead, run the following in an interactive terminal with `MANIFEST` set to the private manifest copy. It selects the first current Micme non-PCM public-file slot, requires the native provisioning above, and does not fall back to the seed. Use `--transfer` for saved observations, not this interactive replay.

```bash
npm run test:live-native -- --pi-local "$MANIFEST"
```

### Rerun the frozen comparison (V1)

From the benchmark checkout, use the unchanged manifest copy and a **new** output path in an existing writable directory:

```bash
npm run test:live-native -- --transfer "$MANIFEST" "$WORK/transfer-replay.jsonl"
```

The runner first saves `transfer-replay.jsonl.manifest.json` next to the output, then appends one JSONL take per planned slot in deterministic interleaved order. It keeps failures, timeouts, lost and unavailable slots. If a sidecar is missing, a condition is unsupported or the collector cannot prove isolation, it does not fall back to a personal instance. Read the take's `gaps` for the reason. A zero exit means the collection loop finished, not that every slot passed. Rerun with another output name; do not append to, select the best of, or replace the frozen takes.

The manifest fixes the fixture PCM and human reference, build, language/task, rig and conditions, including width, target/prefix, input, gesture, cache, load and processing. The first listed build is the comparison reference. Keep PCM recognition, paced capture and destination delivery separate, as well as default and exact-artifact matched panels. Do not call a paced WAV a physical or loopback capture. Keep cold-process, warm-model and idle-reload conditions separate; a fresh process does not prove a cold disk. Record the observed backend and bound device separately from the request; do not infer identity from the backend family. To plan a new comparison, use a different manifest: save reference/reference repeats before inspecting the candidate, with the nearest-rank p95 absolute pair difference per interval as frozen tolerance. The [B/Q schema](transfer-schema.mjs) and [reporter](transfer-report.mjs) enforce the contract. Fewer than 20 otherwise comparable pairs is exploratory; missing observers, unverifiable identity or unrelated conditions do not become parity results.

Per-take stages are offsets in milliseconds from that take's trigger on the collector's monotonic timeline. First sample, ready cue, useful rendered draft, native endpoint, editor commit, raw final, replay and correct target are distinct observations. Use the controlled prompt/editor and its mutations to grade delivery; do not infer it from ASR text, clipboard state or the app's paste timer. Record a gap when a stage is unobserved. The report keeps raw, cleaned, replayed and delivered text distinct, counts errors and noncompletion, and shows median/p95 with finite counts and paired deltas only for finite comparable observations. Missing applicable latency contributes infinity, not zero. Read WER with its substitutions, deletions and insertions, CER for the appropriate scripts, and translation meaning review separately. A blocked hardware, permission or reference-only cell needs a reason and the direct observation that would resolve it, not a parity claim.

### Regenerate the public reports (V2)

Regeneration reads saved evidence only; it does not rerun Pi, Handy or a model. Run from the checkout root after the producer-owned bundle is available:

```bash
npm run test:live-native -- --transfer-report test/live-native test/live-native/transfer-baseline.md --baseline-only
npm run test:live-native -- --transfer-report test/live-native test/live-native/transfer-results.md
```

The first command reads only the frozen `transfer-p1-manifest.json`, `transfer-q-p1.jsonl` and its referenced evidence. The second requires every Q input below and its referenced files. Regenerate to scratch for a byte comparison before publishing; keep published tables next to the bundle so relative links resolve. Do not hand-edit either generated table or regenerate the historical `results.md` with these commands.

| Q input (relative to `test/live-native`) | Evidence owner |
| --- | --- |
| `transfer-q-p1.jsonl` | Task 4, P1 baseline: frozen manifest, public takes and generated baseline table |
| `transfer-q-p2.jsonl` | Task 7, Pi take lifecycle and post-P2 comparison against P1 |
| `transfer-q-p3.jsonl` | Task 10, setup and first local take |
| `transfer-q-p4.jsonl` | Task 12, recognition routing and recovery using Task 11's native evidence |
| `transfer-q-p5.jsonl` | Task 13, language and local finishing |
| `transfer-q-p6.jsonl` | Task 15, library and recovery after Task 14's storage changes |
| `transfer-q-p7-import.jsonl` | Task 16, import and scheduling |
| `transfer-q-p7-cli.jsonl` | Task 17, installed-model WAV CLI |
| `transfer-q-p8-provider.jsonl` | Task 18, provider adapters and hook |
| `transfer-q-p8-final.jsonl` | Task 19, clip processing and live preview |

Each producer owns its Q input and adjacent traces with the same stem; Task 24 alone publishes `transfer-results.md`. Q `evidence` paths and `takes`/`before` references must resolve inside the public bundle; take references use a relative filename and **1-based** JSONL line. Use `before` only for valid frozen references paired to candidate takes under the same conditions. P2 uses a run copy with the candidate build identity changed, not edits to the original manifest or retuned repeats/tolerance. If suitable pairs are missing, leave the comparison unpaired and explain what's missing. The functional `check` is separate from the evidence label (`existing-verified`, `adapted-verified`, `desktop-only-verified`, `blocked`, or `unverified`) and from the comparison outcome. A functional check or a simulated interaction can have useful evidence without making a timed cell pass.

For the catalog reproducibility check, the optional catalog builder must be present. Supply the pinned tagged catalog input and generate to a separate destination for comparison; this is not scorecard regeneration:

```bash
npm run test:live-native -- --transfer-catalog "$PINNED_CATALOG" "$CATALOG_DEST"
```

### Optional recognizer qualification

V3 has two independent paths. For the existing Whisper route, use the [positional matrix and scorer checks](#run-and-replay) at 80/40 columns and the [Worker v1 contract smoke test](../../native/live/README.md#develop-the-worker). This does not exercise the optional recognizer. Do not drive the new route with the positional three-weight matrix.

The optional path requires a checkout with the engine adapter and qualification driver, the separate locally built recognizer and the exact cleared model artifacts. In the private sidecar add `recognizerFile` and `recognizerSha256`, plus `engineModelFiles` entries `{variantId, blobPath, file, sha256}` for **every** ledger blob of the selected variant (`blobPath` is the ledger-relative path, `file` the absolute local file). Provision before going offline. No weight download or substitute variant qualifies. Supply the exact ledger IDs and fresh output paths; run the streamer and the batch variant separately on the P1 fixtures:

```bash
npm run test:live-native -- --transfer-engine "$MANIFEST" "$STREAMER_VARIANT_ID" "$WORK/streamer-takes.jsonl"
npm run test:live-native -- --transfer-engine "$MANIFEST" "$BATCH_VARIANT_ID" "$WORK/batch-takes.jsonl"
```

Repeat for each claimed artifact/backend on the stated OS, architecture and display. Check the requested device against the runtime-bound identity; the list of devices or an installed package is not proof of binding. Using the P4 Q input, regrade the saved B takes through the same reporter. For streaming, check ordered feed/ACK, overload catch-up, exact final drain/hash, zero ASR calls on digital silence, first native endpoint versus relevant visible draft, and matched raw WER. For actual whole-file batch, streaming ACK/catch-up and speculative draft progression are **not applicable**, not a latency pass. Still verify full consumed PCM, raw final, silence and other negative controls, matched accuracy, and correct target once. For chunked routes check actual ordered chunk boundaries and seam text. Keep process failure and successful next-take observations separate. Missing required observations leave the route unverified; don't infer counters from the final text.

# Opt-in native dictation evaluation

This is the Task 7 experiment, not part of normal `npm test`, package checks or installation. It uses actual local Whisper/Silero inference. No microphone, Pi login or network is needed **after** acquiring the inputs and building the two binaries. See [reference-host results](results.md) and the [unchanged quality gates](../../docs/specs/local-dictation-hardening.md#proof).

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
- **Final**: normalized substitutions, deletions and insertions are separate from any draft. JFK and the continuous fixture must finish at ≤20% WER and no more than 10 percentage points above matched clip WER; check the predeclared keyword order for onset, tail and repetition, test raw neighboring finals for a repeated boundary phrase not present in the reference, and require usable short/quiet finals. Only the continuous final keyword gate accepts `1863` or `eighteen sixty three` after the same ordered onset. This does not change WER tokenization or timed draft scoring. Negative controls scan every visible draft and editor write, with zero ASR calls on digital silence. The WER denominator for a no-reference case is undefined (`null`), not 0%.
- **Coverage and cost**: the runner drives the real Micme extension registration, command, resolver, verified growing-WAV capture, Worker v1 transport and recording widget (TUI-shaped context records the actual post-clipping string arrays). A byte-forwarding observer timestamps actual worker events and checks ordered feed/ack ledger, one frame in flight and SHA-256 of fed PCM vs baseline. An overload replay delays the first feed 2.4 s, requiring catch-up frames and the same complete feed. Compare native load/ASR/VAD counts, ASR wall-time/audio-time (aim <1; not a substitute for accuracy), peak lag and peak worker RSS where available. The Node observer adds a small scheduling/I/O cost; a separate real Pi TUI replay is an interaction check, not the timed matrix. Use raw worker events vs the clocked UI trace to distinguish decoder errors from transport or clipping errors.

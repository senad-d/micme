# Why Micme can dictate words that were never spoken

## What the checkout does

Baseline: Micme 0.4.1, `f31e368`. `src/backends.ts:resolveTranscriptionPlan` resolves **clip** auto → trusted custom command, whisper.cpp CLI, then Python Whisper. `src/audio.ts:buildRecorderCommand` uses the configured recorder or FFmpeg's OS-specific input. `prepareAudioForTranscription` and `validateRecordedAudio` normally preprocess to mono/16 kHz and reject too-quiet recordings (default **peak** below −50 dB; not a speech detector). `src/transcription.ts` starts a CLI per clip, with a file, effective model and language/translation flags. Python and C++ weights are not interchangeable.

**Stream** accepts auto/whisper.cpp only, resolves the same C++ model, then starts one `whisper-stream` process per toggle session. The model stays loaded between live inferences. `src/extension.ts:startStreamingTranscription` starts a *second*, optional clip recorder for stop-time replacement only. The default live path never sees FFmpeg's selected microphone, filter, volume check or raw samples. `src/streaming.ts:drainStreamingOutput` sets the meter to 0.55 on recognized-looking text; that is not a measurement of microphone input.

| Setting | Runtime with only stream mode selected | Stream profile written by `/micme conf` |
| --- | ---: | ---: |
| Step / length / keep (ms) | 1000 / 5000 / 500 | 500 / 3000 / 300 |
| Max tokens / VAD threshold requested | 64 / 0.45 | 32 / 0.35 |
| Flush delay (ms) / words per chunk | 700 / 10 | 650 / 5 |

Sources: `src/constants.ts:DEFAULT_STREAM_*` and `STREAM_PROFILE_*`, `src/config.ts` mode profiles/getters, `src/streaming.ts:buildWhisperStreamCommand`. Both paths use positive steps, default SDL capture −1, no context or final clip by default. If compute keeps up, the profile requests twice as many decodes per second. Neither 500 nor 1000 ms is a measured first-text latency.

## What whisper-stream actually supplies

Verified against upstream [v1.9.6 stream implementation](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/stream/stream.cpp#L131-L155) and [v1.8.3](https://github.com/ggml-org/whisper.cpp/blob/2eeeba56e9edd762b4b38467bab96c2517163158/examples/stream/stream.cpp). These stream/SDL implementations matched; other builds and forks may differ.

- [SDL initialization](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/common-sdl.cpp#L17-L79) opens its own mono float/16 kHz microphone. Its capture index is not a Pulse source, DirectShow name or AVFoundation ID. FFmpeg hearing the right voice does not prove SDL heard it. Wrong/quiet SDL input on the reporter's machine is plausible, **not established**.
- Positive steps repeatedly decode growing windows without a speech gate. Max tokens is reset to zero; the VAD threshold is used only at step zero. `-nf` disables temperature retries, not hallucinations. Automatic language detection on short windows can add work. The [decode loop](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/stream/stream.cpp#L253-L342) can miss samples when inference is slower than capture. Step zero's [energy-drop heuristic](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/common.cpp#L613-L647) can accept absolute silence and defer continuous speech until a pause.
- [Readiness and output](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/stream/stream.cpp#L222-L240): `[Start speaking]` is not speech. Positive-step stdout [erases and redraws one line](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/stream/stream.cpp#L346-L429): `ESC[2K CR`, 100 spaces, `ESC[2K CR`, then segment text; newline only on group rollover. This is neither word deltas nor a timestamped transcript. A pipe chunk, long interval between writes, newline, or clean process exit is not acoustic confirmation. Empty segments can redraw a blank line. Step zero instead emits timestamped blocks with START/END headings. Neither stream gives Micme raw input samples on stdout.

## Replaying a correction

Source trace, **not** a native inference or executed benchmark: feed `src/streaming.ts:drainStreamingOutput` two positive-step rewrites in a single upstream group. Let their text be “The ocean is blue” then “Please open system settings”; finish the group and stop. `extractStreamingCandidate` labels the disjoint rewrite incremental; `queueStableStreamingWords` commits the first candidate, stop commits the second. Result: **The ocean is blue Please open system settings**, four insertions on a four-word reference. The first phrase was never confirmed. A 700 ms timer may also commit it before the next nominal 1000 ms update. “Quiet” here describes stdout, not the room.

An ANSI-only redraw does not clear arbitrary false text, and `isLikelyStreamingHallucination` rejects a real “Okay.” or “Thank you.” as well as those phrases on silence. `initializeStreamingRecording` has a per-buffer UTF-8 conversion branch, but `src/processes.ts:spawnRecording` normally sets the text pipe encoding first. Split characters are a transport test case, not an established cause of fluent unrelated English. These failures are independent of which model file is chosen. No recording, reference phrase, hardware profile, or authenticated device selection from the reporting user was available.

## Evidence from the running app

The checkout ran with the README's `pi -e .` command in isolated Pi 1.5.0; the following are observations from eight terminal screenshots taken and inspected in objective 134 (research capture `deliver-plan-plan-help-1-2/notes/screens`). No provider account was used. Pi's yellow “No models available” warning concerns Pi's assistant model, not Micme's Whisper weights.

| Capture | Observation |
| --- | --- |
| 01 General / 02 Transcription | Two-pane keyboard settings, current path and shell-override notice. Clip, whisper.cpp and `ggml-small.en.bin` shown. The mode help promises a low-latency profile. |
| 03 Streaming / 04 Audio | Stream has a separate binary, numeric capture ID −1, context, flush, final pass, VAD slider (0.45) and word chunk. Audio shows a different microphone field, sample/filter settings and silence guard. Adjusting the visible VAD slider cannot affect the positive-step decoder in the reviewed upstream versions. |
| 05 Missing binary | Actual startup correctly reported “Effective backend: none” and missing `whisper-stream`; neither that executable nor `whisper-cli` or usable weights were found in the local research setup. |
| 06 Active stream / 07 Active clip / 08 Completed clip | The editor, elapsed-time widget and status were exercised with **fixture output** for the stream and FFmpeg synthetic audio for the clip. These show where text/status changes appear, not microphone recognition quality. |

There are no before/after WER or native timings from these screenshots. No online comparison UI was named or used.

## What comparable tools do

- [UFAL WhisperStreaming](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/whisper_online.py#L359-L526) confirms common prefixes on successive decodes of *additional audio*, with timestamps to avoid overlap. Its [voice-activity controller](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/whisper_online.py#L629-L725) buffers onset and hangover. That is different from accepting the same terminal text twice. Its published latency is not a Micme target measured on this machine.
- [Handy's live path](https://github.com/cjpais/Handy/blob/ca2334c9099c53a2c4fd9bad63073f11baaa8dbd/src-tauri/src/managers/transcription/live.rs#L70-L200) distinguishes tentative/final events and can batch-decode the *same samples*; its [policy](https://github.com/cjpais/Handy/blob/ca2334c9099c53a2c4fd9bad63073f11baaa8dbd/src-tauri/src/managers/transcription/policy.rs#L5-L68) does not pretend all models support instant live updates. These are architecture comparisons, not apps identified by the reporter, and were not benchmarked head-to-head.
- Upstream [whisper.cpp VAD API](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/include/whisper.h#L668-L764) supports a separate Silero model and stateful speech probabilities; the detection call's boolean indicates computation success, not the presence of speech. [CLI VAD](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/README.md#L908-L988) can gate a file decode, but a new CLI per preview reloads the model. The [server](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/examples/server/README.md#L43-L87) keeps a model loaded and accepts bounded inference requests; it is not a live microphone/PCM protocol.

## Model choice and measurement

`src/constants.ts` defaults to C++ `small.en` and Python `base.en`. `src/models.ts` distinguishes explicit files from named/default downloadable weights and maps translation-incompatible named models to multilingual translate-capable choices. Do not silently replace an explicit model. The transcription language, source language for translation, English-only weights and multilingual weights are different choices.

The [upstream weight table](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/models/README.md#L43-L67) gives about 142 MiB for base and 466 MiB for small; [quantized weight files](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1) can be smaller. File size isn't runtime RAM, latency or accuracy. `base.en` is a useful latency comparison, `small.en` the accuracy-oriented English baseline, multilingual `small` for a non-English source; Turbo is not a translation upgrade. [OpenAI's model table](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md#L57-L102) reports A100 throughput, not on-device Micme measurements.

Use matched PCM, e.g. upstream's public [JFK sample](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/samples/jfk.wav) and a checked reference, digital silence, room noise and quiet/short speech. Compare same model/accelerator/language first; then vary one weight. Record hardware, build, effective compute backend, input, model and audio duration; separate startup, first *correct* live words, stop-to-final and wall time/audio time. Score normalized insertions, deletions and substitutions, speech coverage and false commits on silence. Static replay, fixtures and model marketing cannot establish real-device effectiveness.

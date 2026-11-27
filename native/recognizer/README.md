# Optional offline recognizer

`micme-recognizer` is a separate Linux CPU process for the candidate Moonshine Streaming Tiny and Parakeet TDT v3 GGUFs. Nothing builds it at npm install, discovers it at module import, changes `native/live`, or enables it for normal Whisper dictation. It has no recorder, model downloader, server, plugins, or shell commands. Only use an explicitly pinned local helper or a trusted installation on an absolute `PATH` entry. The helper is process isolation for inference failures, not a sandbox for an untrusted binary.

## Build and notices

The native source is the [transcribe-cpp-sys 0.4.2 archive](https://static.crates.io/crates/transcribe-cpp-sys/transcribe-cpp-sys-0.4.2.crate) from [Handy v0.10.2's Cargo.lock](https://github.com/cjpais/Handy/blob/v0.10.2/src-tauri/Cargo.lock), source commit `275cd50d2c4104c204009a197ac091b9687668e5`, SHA-256 `32f94fb1e9a3033101bbd500d02993cfc95e315f24417038fd42f1fd80e1059a`. Handy's Rust wrapper `transcribe-cpp 0.4.2` has lock checksum `6cf6687b4c73890aea4515632afb1586d48998f22f38e02e3cfbcd7d1543cd4a`; it is a reference, not a dependency. Micme calls that release's C ABI for model load, bound-device queries, session begin/feed/finalize, batch run, and session/model free. The archive also pins its ggml, miniz and Silero segmentation source. The only source modifications in the extracted tree add decoder-entry counters in the two adapted families. This build does not link Rust, media codecs from Handy, system BLAS/OpenMP or GPU backends.

Provision the archive, then disconnect from the network if desired. Use CMake 3.28+, a C/C++17 toolchain and GNU Make. The observed build used GCC 13.3.0 and CMake 4.1.2 on Ubuntu 24.04 x86-64. It requires SSE4.2, AVX2, BMI2, FMA and F16C on x86-64; other Linux architectures are not qualified here.

```bash
curl -fLsS https://static.crates.io/crates/transcribe-cpp-sys/transcribe-cpp-sys-0.4.2.crate \
  -o "$WORK/transcribe-cpp-sys-0.4.2.crate"
cmake -S native/recognizer -B "$WORK/recognizer-build" -DCMAKE_BUILD_TYPE=Release \
  -DTRANSCRIBE_ARCHIVE="$WORK/transcribe-cpp-sys-0.4.2.crate"
cmake --build "$WORK/recognizer-build" --parallel 4
cmake --install "$WORK/recognizer-build" --prefix "$WORK/recognizer-install"
sha256sum "$WORK/recognizer-install/bin/micme-recognizer"
```

Configuration checks the archive hash before extraction. Two separate build directories with the same observed toolchain produced the same helper SHA-256 in the [component record](linux-x64-component.json); this is not a claim of identical bytes across compilers. Keep the installed `share/micme-recognizer/LICENSE.*` with any redistributed executable. These cover Micme, transcribe.cpp, ggml, Mozilla's llamafile SGEMM, miniz and the Silero segmentation code. No Silero weights, third-party model, Handy UI/media, or downloaded source is bundled. Weight attribution and terms are separate: retain the exact ledger's Moonshine MIT and Parakeet CC-BY-4.0 notices if copying weights, do not redistribute them with the executable, and do not assume a sibling variant shares qualification.

## Native boundary and P4 collector

- `loadEngine(choice, signal, {recognizerFile, recognizerSha256, engineModelFiles, threads?, observe?})` accepts the local comparison sidecar's exact pins. A normal installed caller supplies the verified local artifact path(s) from M and may omit **both** executable fields to use the installed helper. The client independently verifies the ledger size/digest and passes a held model descriptor. Ordinary selectable choices must first pass the catalog's exact variant/rig/device/task gate; explicit trial provisioning permits component/P4 measurement without promoting a new offer.
- `listCompute(provision?, signal?)` is **enumeration only**. It preserves distinct IDs within a backend and a null identity for backend-only reports. The loaded engine reports `traits.actualCompute` and `traits.boundDevice` from native model/device queries, not from enumeration. An explicit backend or ID must match that binding. The CPU build does not offer Metal/Vulkan or claim a stable CPU device ID.
- Use `detector: "off"` for this pair. Neither adapter route exposes speech endpoints, Silero, native bias, or translation. Digital-zero gating is not speech detection. There is no separate LID model; the batch model's reported native Auto capability does not qualify all of its advertised languages. Batch-only processing has no streaming drafts, ACK or endpoint gate.
- Feed `16 kHz` mono s16le at consecutive sample offsets. `maxInputSamples` is the enforced per-call batch/overall stream ceiling; above it the adapter refuses the operation rather than returning a partial result as complete. Pass the optional fifth `feed` argument only when the producer actually sent a catch-up block. `observe` gets the ordered feed, real ACK, finish, real done, and actual returned nonempty endpoint text before delivery. Clock them at observation time on the collector's clock. For this streamer the only endpoint is the native final at stop; every pre-stop update is a replaceable draft. There are no early editor commits.
- Take `evidence()` snapshots before and after each take/chunk and after `close()`. `asrCalls`, `asrLoads`, `vadLoads` and peak RSS are helper counters, cumulative per process. `inputSamples` and `inputPcmSha256` are the verified transport receipt count/hash of the current stream or most recent batch (not a claim of using dropped audio). Deferred leading digital-zero samples are fed exactly when nonzero PCM arrives; an all-zero take never invokes the decoder. The closed/saved WAV identity and capture count come from the producer, not these counters. `pid` supports separate current/idle RSS observations. Attribute batch chunks to their actual sample intervals; do not synthesize a streaming trace for batch.
- The private V1 wire uses a length-bounded request opcode and binary PCM over stdin, and bounded framed replies on stdout. One request can be outstanding. A fatal reply, malformed data, timeout or cancellation terminates and reaps the worker; a new take after such a failure needs a new process. Linux parent-death handling stops the worker even if the host dies during inference. A successful reset creates a fresh session against the still-loaded model. A graceful `close()` waits for free/exit; `workerCleanExit` is only true after that observed exit.

## Component observations, not a P4 pass

The [public component record](linux-x64-component.json) covers one cleared Q8_0 Moonshine Streaming Tiny artifact at `85ddff612fa3a2cf40b2f745abcfa90ef82f293b`, and one cleared Q4_K_M Parakeet TDT v3 batch artifact at `85ac09ea12fc4b1112fa76810059364bc6adc9de`. It records weight sizes and digests, actual bound CPU label, one cold-process load, warm reset, load/call counts, RSS, unload, actual speech updates, and killed-process recovery. No mic or editor was opened. A Linux seccomp profile denied `socket` and `io_uring_setup` for the runner and descendants; a positive-control connection socket creation was denied before the run.

- [x] On this CPU, the exact streamer emitted changing relevant JFK drafts before stop. Its final and its same-PCM batch comparator had zero word errors. The separate batch model's JFK result also had zero word errors. Both decoded no words on silence/noise, used zero decoder calls for digital silence, and recognized JFK in a fresh process after a kill.
- [ ] The one-word French probe missed “Paris” on Parakeet (returned “Yeah.”). Other advertised languages need their own tests. Incompatible language, translation, Silero and a nonexistent device ID were rejected on both routes.
- [ ] The ledger qualifies only the two exact English transcribe cells for this build/rig/binding. That is not a P4 pass: the 40/80-column Pi surface, continuous/overload conditions, same-take product retry and destination observations, and timed repeat/calibration gates belong to integrated V3/P4, not this component check. Moonshine F16/F32 and TDT F16/F32/Q5_K_M/Q6_K/Q8_0 lack separate loads and recognition evidence, and GPU/other-OS cells lack a built and qualified runtime. For the other catalog rows consult the per-row exact source/rights/adapter blockers in M.

To rerun the component check from the checkout, provision just the two exact GGUF files under their ledger filenames in `$ASSETS` and the public `jfk.wav`, `paris.ogg` and `rain.wav` from [the comparison's preparation instructions](../../test/live-native/README.md). The script checks the prepared PCM digests. Run it under a network-denied session for independent offline proof.

```bash
ffmpeg -nostdin -v error -i "$ASSETS/jfk.wav" -ar 16000 -ac 1 -f s16le "$ASSETS/jfk.pcm"
ffmpeg -nostdin -v error -i "$ASSETS/paris.ogg" -af 'adelay=250,apad=pad_dur=0.9' \
  -ar 16000 -ac 1 -f s16le "$ASSETS/french.pcm"
ffmpeg -nostdin -v error -i "$ASSETS/rain.wav" -ar 16000 -ac 1 -f s16le "$ASSETS/rain.pcm"
node native/recognizer/smoke.mjs "$RECOGNIZER" "$RECOGNIZER_SHA256" "$ASSETS" > "$WORK/native-smoke.json"
```

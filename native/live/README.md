# Build and install the Micme live worker

Build `micme-live` only if you use Micme's stream mode. The npm package ships the worker sources in `native/live/`, not a binary or model weights. Installing Micme or using clip mode does not build or require the worker. This worker is not whisper.cpp's SDL `whisper-stream` example: it reads PCM from Micme rather than opening a microphone itself.

## Prerequisites

- CMake 3.28 or later, a C compiler and a C++17 compiler, and a build tool for your CMake generator. For example, use GCC and Make on Linux, Apple Clang and Make from the Xcode command-line tools on macOS, or Visual Studio Build Tools with the C++ workload on Windows.
- The Micme package directory (the one containing `native/live/CMakeLists.txt`), or a repository checkout. Building from an already unpacked package does not need npm or Node.js.
- Network access for CMake's first default configure, or a local copy of the pinned whisper.cpp sources for an offline configure. You do not need a microphone, model weights, or a Pi provider login to build or run the version probe.

## Build and install

Run these commands from the Micme package directory or repository root. The configure step downloads the whisper.cpp source archive for revision `96ec4d9823e9d0211944172da35f9f29134af990` (the v1.9.6 pin) and verifies its SHA-256 against [CMakeLists.txt](CMakeLists.txt). The build links whisper.cpp and ggml statically and leaves out the upstream examples, SDL and HTTP server. No separately installed `whisper-cli` is needed to build the worker.

In Bash, Zsh or PowerShell:

```bash
cmake -S native/live -B build/micme-live -DCMAKE_BUILD_TYPE=Release
cmake --build build/micme-live --config Release --parallel
cmake --install build/micme-live --config Release --prefix "$HOME/.local"
```

The install step puts `micme-live` (`micme-live.exe` on Windows) in the prefix's `bin` directory by default. If the package directory is not writable, replace `build/micme-live` in all three commands with an absolute path to a writable build directory. On macOS, Metal is off by default; to opt in with a toolchain that supports it, add `-DGGML_METAL=ON` to the configure command.

## Build without network access

Before going offline, obtain the [pinned whisper.cpp archive](https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/96ec4d9823e9d0211944172da35f9f29134af990). Verify that its SHA-256 is `4d46e659151f31535b3947e322a58b0c604d3cbe93dfb284294e989a19d25ad7`, then extract it. The local-source override skips CMake's download **and** checksum verification, so point it only at a trusted source tree for this exact revision. Do not point it at an installed Whisper binary or library.

Replace the configure command with the following. Substitute the absolute path to the extracted directory containing whisper.cpp's `CMakeLists.txt` (on Windows, use a path such as `C:/src/whisper.cpp`). Then run the same build and install commands against that build directory.

```bash
cmake -S native/live -B build/micme-live -DCMAKE_BUILD_TYPE=Release "-DFETCHCONTENT_SOURCE_DIR_WHISPERCPP=/absolute/path/to/whisper.cpp"
```

## Verify and select the worker

Run the installed worker's version probe. It must exit successfully and write exactly `1` followed by a newline, with no model loading. This checks Worker v1 compatibility, not decoder readiness or transcription quality.

Linux and macOS:

```bash
"$HOME/.local/bin/micme-live" --protocol-version
```

Windows (PowerShell):

```powershell
& "$HOME/.local/bin/micme-live.exe" --protocol-version
```

Add the install's `bin` directory to the `PATH` that Pi sees, or set `MICME_LIVE_BIN` to the full executable path before starting Pi. For example:

```bash
export MICME_LIVE_BIN="$HOME/.local/bin/micme-live"
```

```powershell
$env:MICME_LIVE_BIN = "$HOME/.local/bin/micme-live.exe"
```

If you used a different prefix, use that location in both the probe and the setting. Stream dictation also needs local speech recognition (ASR) and voice activity detection (VAD) weights; neither is installed by CMake.

## Develop the worker

- Keep the no-model probe and dispatch in `main.cpp`. Put decoding in `decoder.cpp`, with `run_live` declared in `decoder.hpp`. Follow the [Worker v1 contract](../../docs/tasks/local-dictation.md#contracts): protocol output on stdout, diagnostics on stderr. Do not add microphone capture, a network listener or weight downloads to the worker.
- Keep new build inputs under `native/live/`. Add them explicitly to `native/live/CMakeLists.txt`, the `files` list in `package.json` and the worker paths in `scripts/check-package-contents.mjs`. Keep build products, upstream source copies, weights and audio out of the npm package.
- From a repository checkout, put the installed worker on `PATH` and run `node --test native/live/worker-contract.test.mjs`. This opt-in smoke test needs no models. Run `npm run check:pack` with the checkout's npm dependencies installed to check the package contents. For end-to-end recognition and latency, see the [native quality task](../../docs/tasks/local-dictation.md#7-measure-recognition-and-live-latency-on-matched-audio).

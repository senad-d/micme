# Security and Privacy

Micme is a pi extension package. Treat it like any other local program that can read files, start processes, and interact with your terminal.

## Trust model

Pi packages and extensions run with full system permissions of the user account that starts pi. A Micme package can execute code during pi startup and when commands or shortcuts run. Review the source, install only trusted versions, and pin versions in sensitive environments:

```bash
pi install npm:<package>@<version>
pi install git:<repo>@<tag>
```

Micme does not add install-time scripts such as `postinstall`, and package installation should not contact the network beyond normal npm/git package retrieval.

## Microphone and local audio handling

Micme records only when you run `/micme` or press the configured shortcut. It does not start recording from the extension factory at package load time.

The default recorder uses `ffmpeg` and your operating system's microphone APIs:

- macOS: `avfoundation`
- Linux: PulseAudio through `ffmpeg -f pulse`
- Windows: DirectShow through `ffmpeg -f dshow`

Micme writes temporary audio files under the operating system temp directory by default and tries to remove them after successful transcription, even if pasting or submitting the transcript fails. If cleanup fails, Micme warns that audio may remain and shows the directory. Run `/micme audio` to find it again in the same session for manual removal.

Set `MICME_KEEP_AUDIO=1` only when you intentionally want to keep raw/preprocessed audio for debugging; kept recordings are written to per-recording project directories such as `./micme-rec/rec-001/`. Micme refuses a symbolic-link recordings root. On Linux and macOS, creation, recording file access, and cleanup use open directories rather than reopening their public pathnames. On Windows, Micme resolves the project path and locks its physical ancestors. It rejects junctions and other reparse points when opening the recordings root and recording directory, and keeps both directories locked during recording and transcription. If you rename `micme-rec`, `/micme audio` still shows the original pathname; verify where it points before removing files manually.

Stream mode uses one recording and holds a verified handle to the growing PCM WAV. Optional final refinement reads from that handle after capture stops, checks the sample count and SHA-256 of the PCM against what was fed to the worker, and gives the clip backend a separate private WAV. It does not reopen the recorder's pathname or take a second recording. Micme attempts to remove the private refinement directory after use even if `MICME_KEEP_AUDIO=1`; that setting applies to the original recording, not the refinement copy.

## Local process execution

Micme spawns local processes for recording and transcription:

- `ffmpeg` for recording, device listing, preprocessing, and volume validation.
- `whisper-cli` or `whisper-cpp` for whisper.cpp clip transcription, including optional live refinement.
- `micme-live` for stream mode. Micme launches it without a shell and sends PCM over stdin; the worker does not open a microphone, download weights, or run a network service. Use a trusted executable on `PATH` or set `MICME_LIVE_BIN` to a trusted binary. See the [worker build guide](native/live/README.md) for the pinned source and its checksum.
- `whisper` for the optional Python openai-whisper fallback.
- `python -I` only for optional Python Whisper model-name discovery in `/micme conf`; isolated mode avoids importing project-local Python files.
- Optional user-provided shell commands in `MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`.

Ordinary captured process output is bounded to 100,000 characters each for stdout and stderr. This limit does not apply to transcript files: Micme reads regular transcript files in full. The live worker uses a separate protocol with UTF-8 JSON lines bounded to 64 KiB per line on stdout and capped diagnostics on stderr. Terminal control sequences (including 8-bit C1 forms) and standalone C1 controls are stripped from process output, transcript text, device panels, and configuration display values before they are shown or inserted into Pi.

## Custom command risks

`MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND` are advanced escape hatches. They run through the local shell (`sh -lc` on Unix-like systems and `cmd.exe` on Windows). Only use commands you wrote or fully trust. When `MICME_TRANSCRIBE_BACKEND=custom`, Micme does not try to inspect, parse, or rewrite the command to infer which model it uses.

Micme replaces these placeholders in custom commands:

- `{audio}` / `{audioRaw}`
- `{tempDir}` / `{tempDirRaw}`
- `{transcript}` / `{transcriptRaw}`

Placeholders without `Raw` are shell-quoted. `*Raw` placeholders bypass shell quoting and can break command safety if a path contains shell syntax. Use raw placeholders only where the target CLI requires an unquoted path fragment and you understand the risk.

Doctor reports the hook's length and any of the supported placeholders above, but redacts the rest of the configured command, including other brace-wrapped text.

That redaction does not apply to hook output. When a custom transcriber exits with a nonzero status, Micme includes its captured stderr in the error message, or falls back to stdout if stderr is empty after sanitization. Micme strips terminal controls but does not redact secrets from that output. Do not log credentials or other secrets to stdout or stderr from custom hooks.

## Model downloads

Automatic model downloads are enabled by default. Micme can contact Hugging Face when clip transcription or stream startup needs missing weights. Selecting a missing standard Whisper model in `/micme conf` can also trigger a download. Package installation and doctor do not download weights.

- **Whisper ASR weights:** Micme downloads recognized standard `ggml-<name>.bin` files from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main`. That branch is not revision-pinned, and Micme does not verify those downloads against pinned SHA-256 digests. The cache is `MICME_MODEL_DIR` (default `~/.cache/whisper.cpp`). If `MICME_WHISPER_CPP_MODEL` points to a missing standard filename, Micme can download to that location, even outside the cache. Clip translation can resolve a sibling path; stream mode does not rewrite an explicit path. Micme does not infer download URLs from arbitrary model names, `.gguf` files, or custom transcriber hooks.
- **Silero VAD weights (stream only):** The default is `vad/ggml-silero-v5.1.2.bin` under `MICME_MODEL_DIR`. Micme fetches the [artifact from `ggml-org/whisper-vad` at revision `9ffd54a1e1ee413ddf265af9913beaf518d1639b`](https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin). It checks the length (885,098 bytes) and SHA-256 (`29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf`) before publishing a download and checks the default file again at live startup. A corrupt cached file is rejected, not silently replaced. A `MICME_VAD_MODEL` override outside that default path must already exist as a regular file; Micme neither downloads it nor checks it against the standard digest. Use trusted weights.

Downloads use a temporary file and move it into place after completion. Micme bounds header, body, and file-output inactivity to two minutes and attempts to remove temporary files on failure or cancellation. Concurrent startup requests for the same weight share one transfer within a Pi process; only cancellation by the last caller stops that transfer.

For offline use, build or install the worker if needed, provision the required weights beforehand, and set `MICME_AUTO_DOWNLOAD_MODEL` to `0` in `micme.json` or pass it to Pi in the shell:

```bash
MICME_AUTO_DOWNLOAD_MODEL=0 pi
```

Use the standard cache paths or point `MICME_WHISPER_CPP_MODEL` and, for stream mode, `MICME_VAD_MODEL` at trusted local files. This setting controls Micme's downloader, not network use by Python Whisper or a custom command.

## Micme config handling

Micme reads `micme.json` from one directory and `/micme conf` saves to the same file. Micme chooses the directory in this order:

1. An explicit `PI_CODING_AGENT_DIR` override, if nonblank after trimming. Relative paths are resolved against the Pi process's current working directory.
2. The agent directory returned by Pi's `getAgentDir()` helper, if available.
3. `~/.pi/agent` as the home-directory fallback.

If `micme.json` is missing in the selected directory, Micme does not look in the next directory. Micme reads only `MICME_*` runtime keys from JSON; shell environment variables override saved values. `/micme conf` writes only `MICME_*` values and preserves other JSON metadata.

Micme does not discover project configs by default. But if you start Pi from a project directory with `PI_CODING_AGENT_DIR=.`, Micme reads and writes that project's `micme.json` as trusted user configuration. When used, [custom command hooks](#custom-command-risks) from that file (`MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`) run with your user permissions. Point the agent directory only at locations whose configuration you trust, and avoid placing secrets in custom commands.

## Telemetry and retention

Micme has no telemetry and does not use a remote speech-to-text service by default. Live drafts are not sent as prompts. Completed transcripts can become Pi prompts when you submit them, enable eligible auto-submit, or explicitly replay with auto-submit on. For local audio retention and cleanup, see [Microphone and local audio handling](#microphone-and-local-audio-handling).

Local transcription does not imply offline first use: see [Model downloads](#model-downloads) for when Micme can contact Hugging Face. Your own custom commands can also contact the network.

## Reporting vulnerabilities

Before publishing, confirm the final security contact in `package.json` and this file. For now, report issues through the repository issue tracker listed in `package.json` and avoid posting sensitive exploit details publicly.

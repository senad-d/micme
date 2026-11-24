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

## Local process execution

Micme spawns local processes for recording and transcription:

- `ffmpeg` for recording, device listing, preprocessing, and volume validation.
- `whisper-cli` or `whisper-cpp` for whisper.cpp transcription.
- `whisper-stream` for experimental streaming mode.
- `whisper` for the optional Python openai-whisper fallback.
- `python -I` only for optional Python Whisper model-name discovery in `/micme conf`; isolated mode avoids importing project-local Python files.
- Optional user-provided shell commands in `MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`.

The default process output is capped. Terminal control sequences (including 8-bit C1 forms) and standalone C1 controls are stripped from process output, transcript text, device panels, and configuration display values before they are shown or inserted into pi.

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

Automatic downloads are enabled when `MICME_AUTO_DOWNLOAD_MODEL` is unset. If a standard whisper.cpp model is missing, Micme can contact the whisper.cpp repository on Hugging Face without a separate opt-in the first time it transcribes a clip or starts streaming transcription. Selecting a missing standard model in `/micme conf` can also trigger a download.

Without an explicit model path, Micme downloads to `MICME_MODEL_DIR`, which defaults to `~/.cache/whisper.cpp`. Setting `MICME_WHISPER_CPP_MODEL` overrides the cache location: for example, if `/path/to/ggml-tiny.bin` is missing, Micme downloads the model to that path, even if it is outside the cache. If translation requires a different model, Micme uses the corresponding filename in the same directory as the explicit path.

Disable Micme's automatic whisper.cpp downloads with:

```bash
MICME_AUTO_DOWNLOAD_MODEL=0
```

You can also download models manually and set `MICME_WHISPER_CPP_MODEL=/path/to/model.bin`. Micme only auto-downloads standard, inferable whisper.cpp model files and does not treat arbitrary custom-command model references as downloadable assets.

## Micme config handling

Micme reads `micme.json` from one directory and `/micme conf` saves to the same file. Micme chooses the directory in this order:

1. An explicit `PI_CODING_AGENT_DIR` override, if nonblank after trimming. Relative paths are resolved against the Pi process's current working directory.
2. The agent directory returned by Pi's `getAgentDir()` helper, if available.
3. `~/.pi/agent` as the home-directory fallback.

If `micme.json` is missing in the selected directory, Micme does not look in the next directory. Micme reads only `MICME_*` runtime keys from JSON; shell environment variables override saved values. `/micme conf` writes only `MICME_*` values and preserves other JSON metadata.

Micme does not discover project configs by default. But if you start Pi from a project directory with `PI_CODING_AGENT_DIR=.`, Micme reads and writes that project's `micme.json` as trusted user configuration. When used, [custom command hooks](#custom-command-risks) from that file (`MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`) run with your user permissions. Point the agent directory only at locations whose configuration you trust, and avoid placing secrets in custom commands.

## Telemetry and retention

Micme has no telemetry. It does not send audio or transcripts to a remote service by default. For local retention and cleanup, see [Microphone and local audio handling](#microphone-and-local-audio-handling).

Local transcription does not imply offline first use: see [Model downloads](#model-downloads) for when Micme can contact Hugging Face. Your own custom commands can also contact the network.

## Reporting vulnerabilities

Before publishing, confirm the final security contact in `package.json` and this file. For now, report issues through the repository issue tracker listed in `package.json` and avoid posting sensitive exploit details publicly.

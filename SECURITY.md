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

Micme writes temporary audio files under the operating system temp directory while a recording is being processed. After successful transcription, those files are removed by default. Set `MICME_KEEP_AUDIO=1` only when you intentionally want to keep the last raw/preprocessed audio for debugging.

## Local process execution

Micme spawns local processes for recording and transcription:

- `ffmpeg` for recording, device listing, preprocessing, and volume validation.
- `whisper-cli` or `whisper-cpp` for whisper.cpp transcription.
- `whisper-stream` for experimental streaming mode.
- `whisper` for the optional Python openai-whisper fallback.
- Optional user-provided shell commands in `MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`.

The default process output is capped before it is shown to users or errors. Diagnostics should not print secret values.

## Custom command risks

`MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND` are advanced escape hatches. They run through the local shell (`sh -lc` on Unix-like systems and `cmd.exe` on Windows). Only use commands you wrote or fully trust. When `MICME_TRANSCRIBE_BACKEND=custom`, Micme does not try to inspect, parse, or rewrite the command to infer which model it uses.

Micme replaces these placeholders in custom commands:

- `{audio}` / `{audioRaw}`
- `{tempDir}` / `{tempDirRaw}`
- `{transcript}` / `{transcriptRaw}`

Placeholders without `Raw` are shell-quoted. `*Raw` placeholders bypass shell quoting and can break command safety if a path contains shell syntax. Use raw placeholders only where the target CLI requires an unquoted path fragment and you understand the risk.

## Model downloads

When `MICME_AUTO_DOWNLOAD_MODEL=1` (default), Micme can download missing standard whisper.cpp model files from the whisper.cpp Hugging Face repository on first use or model selection. Downloads are stored in `MICME_MODEL_DIR`, defaulting to `~/.cache/whisper.cpp`.

Disable model downloads with:

```bash
MICME_AUTO_DOWNLOAD_MODEL=0
```

You can also download models manually and set `MICME_WHISPER_CPP_MODEL=/path/to/model.bin`. Micme only auto-downloads standard, inferable whisper.cpp model files and does not treat arbitrary custom-command model references as downloadable assets.

## Micme config handling

Micme reads only `MICME_*` runtime keys from `~/.pi/agent/micme.json`. Shell environment variables override saved JSON values.

`/micme conf` writes only `MICME_*` values to `micme.json` and preserves other JSON metadata. Micme uses its own global config store to reduce accidental project influence over microphone and command-hook behavior.

Treat `micme.json` as trusted local user configuration. Command hooks stored there, especially `MICME_RECORD_COMMAND` and `MICME_TRANSCRIBE_COMMAND`, execute local shell commands with your user permissions. Avoid placing secrets in custom commands.

## Telemetry and retention

Micme has no telemetry. It does not send audio or transcripts to a remote service by default. It does not retain audio after successful transcription unless `MICME_KEEP_AUDIO=1` is configured.

Network access can occur only when you explicitly use features that need it, such as automatic model downloads, or when your own custom commands contact the network.

## Reporting vulnerabilities

Before publishing, confirm the final security contact in `package.json` and this file. For now, report issues through the repository issue tracker listed in `package.json` and avoid posting sensitive exploit details publicly.

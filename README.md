<p align="center">
  <img alt="Micme logo" src="img/micme_logo.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/micme"><img alt="npm" src="https://img.shields.io/npm/v/micme?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  Local voice-to-text for <a href="https://pi.dev">pi</a>.
  <br />Tap a shortcut, speak, and paste the transcript into pi's editor.
</p>

---

Micme is a pi extension for short coding prompts. It records your microphone with `ffmpeg`, transcribes locally with `whisper.cpp` or another local backend, and inserts the transcript into pi.

- **Local-first:** no telemetry and no cloud STT service by default.
- **Review-first:** transcripts paste into the editor unless you enable auto-submit.
- **Pi-native:** install globally, project-locally, from git, or from a source checkout.
- **Configurable:** use `/micme conf`, `.env`, or shell variables.

> **Security:** pi packages run with your full system permissions. Micme can use your microphone, spawn local commands, write `MICME_*` settings to `.env`, and optionally download Whisper model files. Read [`SECURITY.md`](SECURITY.md).

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Backend Setup](#backend-setup)
- [Configuration](#configuration)
- [Commands](#commands)
- [Models and Backends](#models-and-backends)
- [Troubleshooting](#troubleshooting)
- [Diagnostics](#diagnostics)
- [Update and Uninstall](#update-and-uninstall)

---

## Quick Start

```bash
pi install npm:micme
```

Install a local backend. On macOS:

```bash
brew install ffmpeg whisper-cpp
```

Start pi and configure Micme:

```bash
pi
```

```text
/micme conf
/micme devices
```

Use it:

1. Press `alt+m` / `Option+m` to start recording.
2. Speak your prompt.
3. Press `alt+m` again to stop.
4. Review the pasted transcript and press Enter.

Micme is toggle-based. Press-and-hold recording is not used because terminal key-up events are not portable.

---

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:micme` | Loads in every trusted pi project. |
| Project-local | `pi install npm:micme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:micme` | Try without changing settings. |
| Git | `pi install git:github.com/senad-d/micme@<tag>` | Pin a tag or commit. |
| Local checkout | `pi -e .` | Develop or test this repository. |

Source checkout:

```bash
git clone https://github.com/senad-d/micme.git
cd micme
npm install --ignore-scripts
npm run doctor
pi -e .
```

Use the checkout globally while developing:

```bash
pi install /absolute/path/to/micme
```

---

## Backend Setup

Micme does not bundle recorder, transcriber, or model binaries.

| OS | Install | Device setting |
| --- | --- | --- |
| macOS | `brew install ffmpeg whisper-cpp` | `MICME_AUDIO_DEVICE=0` or `MICME_AVFOUNDATION_INPUT=:0` |
| Linux | Install `ffmpeg` and `whisper.cpp` with your package manager, Nix, Homebrew, or source build. | `MICME_PULSE_SOURCE=default` |
| Windows | `winget install Gyan.FFmpeg`, then install/build `whisper.cpp`. | `MICME_DSHOW_AUDIO_DEVICE=Microphone Name` |

List devices inside pi:

```text
/micme devices
```

macOS device listing outside pi:

```bash
ffmpeg -hide_banner -f avfoundation -list_devices true -i ""
```

If `whisper-cli` is not on `PATH`, set it explicitly:

```env
MICME_WHISPER_CPP_BIN=/path/to/whisper-cli
MICME_WHISPER_CPP_MODEL=/path/to/ggml-small.en.bin
```

---

## Configuration

Micme reads settings from shell environment variables and from a project `.env`. Shell variables win. `/micme conf` writes only `MICME_*` keys to `.env`.

Use the example file in the project where you run pi:

```bash
cp .env.example .env
```

If the project already has a `.env`, copy only the `MICME_*` lines you need. For a global pi install, do not edit the package directory; put `.env` in each project or set shell variables in your shell profile.

Minimal `.env`:

```env
MICME_LANGUAGE=en
MICME_AUTO_DOWNLOAD_MODEL=1
MICME_DEFAULT_WHISPER_CPP_MODEL=small.en
MICME_AUTO_SUBMIT=0
MICME_KEEP_AUDIO=0
```

Common settings:

| Variable | Meaning |
| --- | --- |
| `MICME_TRANSCRIPTION_MODE=clip` | Stable default: transcribe after recording stops. |
| `MICME_TRANSCRIPTION_MODE=stream` | Experimental live preview with `whisper-stream`. |
| `MICME_AUTO_SUBMIT=0` | Paste for review. Set `1` to send automatically. |
| `MICME_SHORTCUT=alt+m` | Toggle shortcut. Restart or `/reload` after changing. |
| `MICME_PRINTABLE_SHORTCUTS=§` | macOS Option-key fallback. |
| `MICME_VALIDATE_AUDIO=1` | Reject near-silent recordings. |
| `MICME_KEEP_AUDIO=0` | Delete successful temp audio. Set `1` for debugging. |
| `MICME_MODEL_DIR=~/.cache/whisper.cpp` | Model cache/discovery directory. |

See [`.env.example`](.env.example) for the full template.

---

## Commands

| Command | Description |
| --- | --- |
| `/micme` | Toggle recording. |
| `/micme conf` | Open the TUI configuration screen. |
| `/micme devices` | List audio input devices. |
| `/micme last` | Paste the previous transcript again. |
| `/micme audio` | Show the last kept audio directory. |
| `/micme help` | Show short help. |

---

## Models and Backends

Default backend: `whisper.cpp` via `whisper-cli`.

With `MICME_AUTO_DOWNLOAD_MODEL=1`, Micme downloads missing standard models into `MICME_MODEL_DIR`. Disable downloads with:

```env
MICME_AUTO_DOWNLOAD_MODEL=0
```

Recommended model progression: `base.en` for speed, `small.en` for a stronger default, `medium.en` for accuracy.

Advanced users can replace the recorder or transcriber:

```env
MICME_RECORD_COMMAND=ffmpeg -hide_banner -loglevel error -f avfoundation -i :0 -ac 1 -ar 16000 -y {audio}
MICME_TRANSCRIBE_COMMAND=whisper-cli -m /path/to/model.bin -f {audio} -otxt -of {tempDirRaw}/out -nt -np && cat {tempDirRaw}/out.txt
```

`{audio}`, `{tempDir}`, and `{transcript}` are shell-quoted. `*Raw` placeholders bypass quoting and should only be used when you fully control the command.

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| No backend found | Install `whisper.cpp`, put `whisper-cli` on `PATH`, or set `MICME_WHISPER_CPP_BIN`. |
| Wrong microphone | Run `/micme devices`, then set the OS-specific device variable. |
| Unrelated transcript | You probably recorded silence. Set `MICME_KEEP_AUDIO=1` and check `/micme audio`. |
| Slow transcription | Use `whisper.cpp`, a smaller model, and shorter recordings. |
| Option/Alt inserts `§` or `µ` | Set `MICME_PRINTABLE_SHORTCUTS=§` or change `MICME_SHORTCUT`, then `/reload`. |
| Need automatic sending | Set `MICME_AUTO_SUBMIT=1`. |

---

## Diagnostics

```bash
npx -p micme micme-doctor
```

From a source checkout:

```bash
npm run doctor
```

The doctor checks Node, pi, `ffmpeg`, whisper.cpp, optional `whisper-stream`, model paths, and macOS devices when available. Custom command values are redacted.

---

## Update and Uninstall

```bash
pi update --extensions       # update installed pi packages
pi update npm:micme          # update Micme only
pi remove npm:micme          # remove global install
pi remove npm:micme -l       # remove project-local install
```

---

## Development

```bash
npm ci
npm run validate
pi -e . --list-models micme-load-test
```

## License

MIT

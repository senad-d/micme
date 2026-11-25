# Live words in Pi and truthful microphone settings

Kind: interface

## Purpose and scope

Show correctable live text during an utterance without turning every guess into part of the prompt. Keep the existing recording widget, editor, settings panes and keyboard flow. No new dashboard, theme or command. Configuration must name the microphone and models the live path actually uses.

## Screens today

| Screen | Path | What the screenshot shows | Screenshot | Source file |
| --- | --- | --- | --- | --- |
| Configuration | `/micme conf` → General / Transcription | Two panes, mode clip, model `ggml-small.en.bin`, auto-download ON. Mode helper promises a different profile. | Captures 01–02 | `src/settings.ts:buildConfigurationItems` |
| Inputs and decoder | Streaming / Audio panes | Numeric SDL device −1 and a VAD slider beside another pane with unrelated FFmpeg device and silence guard. Linux Audio help in this capture describes AVFoundation. | Captures 03–04 | `src/settings.ts:buildConfigurationItems` |
| Start error | `/micme` in stream mode | In the actual run: effective backend none; missing `whisper-stream`. | Capture 05 | `src/extension.ts:resolveStreamingTranscriptionPlan` |
| Active recording / complete | Pi widget, status, editor | Active stream fixture writes directly to editor; elapsed time/waveform above. Synthetic clip fixture leaves editor blank until completion. These are not model results. | Captures 06–08 | `src/recording-widget.ts:RecordingWidget`, `src/streaming.ts:renderStreamingPreview` |

Capture names and observations are preserved in the [running-checkout record](../research/local-dictation.md#evidence-from-the-running-app); all eight original screenshots were inspected.

## Target screens

| Screen | Layout | Order of elements | Changes | Stays |
| --- | --- | --- | --- | --- |
| Recording | Existing status and recording widget; a separate draft line below its waveform, outside the editor | Status/time/meter, `Live:` draft, confirmed prompt in editor | Replace the draft on each partial. It must appear before pause; clear on final, empty, stop, error and shutdown. The confirmed editor text described here is TUI only; live RPC never edits or sends automatically. No notification per word. | Toggle, review-before-send, last transcript, editor interaction |
| General / Transcription | Existing panes, same categories | Existing fields | Explain the mode switch's [final-pass reset](local-dictation-feature.md#compatibility) and live's local worker + speech detector requirement; keep backend/model controls for clip/C++. General diagnostics describe timings, not raw terminal frames. | Language/translation, model selection, shortcuts and shell precedence |
| Streaming | Existing settings list | Live decoder executable, speech detector model, optional final clip pass | Replace SDL, flush, VAD-slider, context and word-chunk rows. Explain fixed speech-gated format and refer to Audio for input. No pretend slider or inferred “accuracy” score. | Existing list display and default path indications; show effective paths and config-file/env keys, not a text editor |
| Audio | Existing list | Microphone first, remaining fields in existing order | Linux binds the Pulse source, macOS AVFoundation, Windows exact DirectShow name. Describe which controls are clip-only and any env input/custom-hook override. | Same device inventory/selection flow and true capture values |

## States

| Screen | State | What is shown |
| --- | --- | --- |
| Recording | Loading | Existing status distinguishes preparing models/starting from listening. No false meter/draft before valid PCM. |
| Recording | Listening, no speech | Streaming status and measured waveform; no `Live:` row and no editor changes. |
| Recording | Speaking | Labeled draft updates in place on voiced partials; each final is appended once in TUI, retained without writing the host prompt in RPC. No duplication when the same audio is revised. |
| Recording | Stopping / finalizing | Preserve confirmed editor content, clear speculative view; wait for acknowledged tail. No premature submit. |
| Recording | Done / no words | Clear widget/status. Confirmed prompt ready for review in TUI; saved-transcript/replay guidance in RPC. No-words warning leaves either editor untouched. |
| Recording | Setup/error/shutdown | Sanitized missing component/format/recorder error with repair hint when current. No draft, stale meter or accidental submission; no late error from a cancelled session. |
| Recording | Observable TUI insertion | Continue the independent draft, append stable spans to the observed buffer, do not replace/auto-send after detecting added user text. Existing clear/trim behavior is documented in feature §Compatibility. |
| Recording | RPC host prompt unknown, including after a tracked replay | Show the live widget. No automatic set/paste/send on any span or finish. On success explain that the result is saved and explicit `/micme last` will replace the prompt or send it, depending on auto-submit; protect the current prompt first. Do not claim to detect host edits. |
| Settings | Missing model/binary, override or incompatible backend | Effective value and actionable help; offer clip in existing mode control, don't change mode behind user's back. Custom command values remain redacted in diagnostics. Malformed config retains existing repair-only behavior. |

## Flows

### Dictate and review

1. Open Pi with the provisioned local component and weights. Toggle as usual. Wait for listening; a setup failure never presents a recording indicator.
2. Speak a continuous sentence. Read the changing `Live:` line while still speaking. A revision replaces that line, not the user's prompt.
3. Pause/resume or stop. In TUI, review the confirmed prompt (or use configured auto-submit). In RPC, use the saved result only when ready for the explicit replay action. On failure retain user content and surface the repair hint.

### Configure live dictation

1. Open `/micme conf`, choose Transcription → stream. Then opt in to Stream final pass if wanted, and choose an appropriate C++ model and source language.
2. Streaming shows the effective `MICME_LIVE_BIN` and `MICME_VAD_MODEL` or their defaults. Audio cycles through discovered/current inputs. These are not arbitrary text fields (`src/settings.ts:activateSelectedSetting`); Linux discovery currently offers only `default` (`src/audio.ts:discoverAudioDevices`).
3. For an unlisted source or either non-default path, edit the `micme.json` whose path appears in the settings header. Set `MICME_PULSE_SOURCE` to the exact Pulse source name and the two path keys to the installed executable and VAD file. Alternatively set those three shell variables before starting Pi; shell overrides win. Restart Pi for a fresh config, reopen settings and verify the effective values. No new discovery or text-entry control.
4. Toggle; the same input feeds live and final. If a component is missing, the error names the remedy and clip alternative. Doctor gives the effective plan without starting capture or sending samples anywhere.

## Look

| Element | Property | Today | Target | Token or variable |
| --- | --- | --- | --- | --- |
| Live draft | Content/emphasis | No provisional display in recording widget | One labeled single-line, sanitized tail of current hypothesis; never style speculative text like a submitted message | Existing Pi widget API/theme; plain `Live:` label |
| Meter/status and settings | Size/colour/category layout | Existing elapsed time/wave and two-pane categories in recorded screens | Preserve layout/tokens; use actual capture signal, rename/remove ineffective rows | `RECORDING_WIDGET_KEY`, existing setting renderers |

## Responsive rules

| Breakpoint | What changes |
| --- | --- |
| Normal width | Preserve current pane navigation and meter; keep the most recent draft readable without stealing editor focus. |
| Narrow terminal / long Unicode draft or path | Use existing width-aware clipping/ellipsis, keep `Live:` and newest words visible. Do not slice ANSI or a wide character, wrap headers into the prompt, or truncate the actual final transcript. Resize redraws the same draft. |

## Accessibility

| Screen | Keyboard order | Focus after each action | Labels | Contrast | Announced |
| --- | --- | --- | --- | --- | --- |
| Configuration | Existing Tab/arrows/Enter/search/Esc flow | Keep selection in its pane; clamp to valid row if model/backend changes | Name local worker, speech detector and OS input explicitly | Existing Pi theme | Existing help/error notification, not colour alone |
| Dictation | Unchanged toggle; no extra focusable widget | Editor focus never moves to a draft | `Live:` identifies tentative text; status names listening/finalizing | Existing legible UI colour; no faint-only significance | No per-token toast; single warning for actionable failure/no words |

## References seen

None. No online UI example was named.

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Live surface | A replaceable, labeled draft near the existing meter; final text in editor | Overwrite editor on every hypothesis or delay all feedback until endpoint | Shows words during speech and preserves editor ownership. |
| Settings | Retain familiar panes, remove SDL-only controls, use existing model/input fields | Add a second microphone picker or separate model-quality dashboard | There is one capture path, and model choice is already exposed. |

## Open questions

| Question | Who can answer | What waits for it |
| --- | --- | --- |
| Unverified: exact clipping of the new draft and paths on a narrow running terminal; baseline screenshots show one terminal width. | Running Pi at normal and narrow widths during merged verification | Only visual acceptance. The settings and recording flow themselves were observed. |

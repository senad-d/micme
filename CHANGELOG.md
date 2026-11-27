# Changelog

All notable changes to Micme will be documented in this file.

## Unreleased

- Support Oh My Pi 19.2 settings, device panels, and dictation without changing the upstream Pi UI. Use Node for subprocess helpers under Bun-compiled hosts. Thanks to [@JasonLandbridge](https://github.com/JasonLandbridge) for the contribution in [#156](https://github.com/senad-d/micme/pull/156).
- Preserve Pi's built-in keyboard shortcuts by installing Micme's editor fallback only for printable-character shortcuts and retaining the `CustomEditor` app-handler contract when wrapping another extension's editor.
- Move normal Micme persistence to the global `~/.pi/agent/micme.json` store; shell environment variables still override saved settings.
- Update `/micme conf`, `micme-doctor`, docs, and package examples for the new global JSON config path.
- Document the scoped npm package name, `@senad-d/micme`, in install, diagnostics, update, and uninstall commands.
- Add an interactive npm publishing script that prompts for a version, validates the package, creates the release commit/tag, and publishes with public scoped-package access.
- Keep publication on hold until package name, metadata, security review, validation, and smoke tests are complete.
- Add explicit transcription backend selection with backend-specific `/micme conf` model rows, doctor diagnostics, schema, and docs.
- Add a single `MICME_TRANSLATE_TO_ENGLISH` setting that translates selected source languages to English and switches default Whisper model names to multilingual variants.
- Store kept audio in sequential project directories under `./micme-rec/rec-###/` instead of the system temp directory.
- Make the recorder quality-safe by default: preserve recorder timing from ffmpeg timestamps, disable the stdout meter branch, and ask macOS AVFoundation not to drop late frames.
- Rename the translation UI to “Translate from” and automatically route translation away from non-translation Whisper turbo models to the closest translate-capable model.
- Harden user-facing diagnostics by stripping terminal control sequences from external process output, config paths, device output, and doctor messages.
- Strip terminal control sequences from transcript delivery, device panel rendering, and `/micme conf` display values before showing or inserting text in pi.
- Make model downloads fail clearly when the target path is not a regular file, and clean up temporary files after interrupted response streams.
- Preserve backend warnings when invalid backend or binary configuration falls back to an effective backend.
- Keep streaming dictation append-only while inserting a natural separator between existing editor text and dictated words when needed.
- Add dependency-free `npm run lint` and `npm run format:check` validation scripts.
- Include README-referenced demo/logo assets in the npm package dry run.
- Align `micme-doctor` executable/model checks with runtime validation and translation-capable model fallback behavior.
- Let `MICME_RECORD_COMMAND` use the same `{audio}`, `{tempDir}`, and `{transcript}` placeholders as custom transcription commands.

## [0.5.0] - 2026-11-26

- Stream mode replaces whisper-stream with micme-live and VAD weights, defaults to base.en for English live drafts, and requires existing stream users to migrate; clip mode retains its previous model default.
- Linux PulseAudio recording no longer passes the input option that prevented FFmpeg 9.1 from starting capture.
- Fix Micme loading, settings and recording controls in OMP 19.2.0 while preserving upstream Pi’s configured model-picker keys.

## [0.4.1] - 2026-11-24

- Micme preserves text typed or replayed into the editor during live dictation instead of replacing or auto-submitting the edited draft.
- Failed recordings keep captured audio for debugging but discard empty or header-only attempts. Session shutdown keeps captured audio only when Keep audio is on or Micme already reported the clip as kept.
- On POSIX, recorder processes that stay in Micme’s process group are stopped if Pi is killed.

## [0.4.0] - 2026-11-24

- Micme now keeps partial audio and reports its location when a recorder exits during startup, while still removing empty attempts.
- Selected Python model names in settings no longer display terminal styling supplied by discovery.
- Doctor no longer prints unsupported brace-wrapped hook values in diagnostics.
- The shipped security guide now warns that failed custom hooks can expose credentials written to stdout or stderr.
- The configuration guide now explains which micme.json Micme reads and writes, and why pointing Pi at a project means trusting that project’s command hooks.
- Micme now rechecks configuration after capture stops and keeps the raw audio instead of processing it or downloading a model when the configuration is invalid.
- The documentation clarifies when first use can contact Hugging Face and how an explicit model path changes the download destination.
- Ending or replacing a session now cancels pending device scans and settings saves so they cannot show stale results or change the next session’s configuration.
- The shipped security guide clarifies that the 100,000-character limit applies separately to captured stdout and stderr, not to transcript files.
- Streaming now keeps delivering live words when FFmpeg is missing or the optional final-clip recorder fails to start.
- Replaying /micme last during live streaming no longer loses the replayed text when the next word arrives.
- Micme now warns when a live-only recording stops without recognizing any words, leaving your draft untouched.
- A failed /micme devices command now shows its error without clearing the status of an ongoing recording.
- Package validation now names declared Pi extensions and command files missing from the npm tarball.
- Kept recordings are protected against root substitution; on macOS and Linux without usable procfs, custom hooks now run in the recording directory and must use absolute paths for project-relative tools or resources.
- The package manifest check now launches npm through Node on Windows instead of trying to execute npm.cmd directly.
- Micme now cleans up temporary audio after successful transcription even if it cannot paste or submit the transcript.
- After a live stream fails, Micme reports and remembers a partial clip or removes the unused recording directory.
- Settings save errors no longer expose excerpts from malformed config files and still show the file path and repair hint.

## [0.3.10] - 2026-11-24

- On Windows, batch shims no longer hide a later native Whisper executable or prevent automatic fallback to Python Whisper.
- Windows recording now uses the microphone selected in settings after reload, while an unset selection keeps automatic discovery.
- Recordings in directories with volume-like names are now validated using FFmpeg’s measured volume instead of a value from the directory name.
- Stopping recording, cancelling transcription, or timing out now cleans up owned hook workers without hanging on inherited pipes, while preserving graceful recorder shutdown.
- Micme now accepts a custom FFmpeg recorder’s exit code 255 after Micme sends SIGINT, while still rejecting a recorder that already exited with 255.
- When the primary recorder exits unexpectedly, Micme now clears the recording widget, stops any companion recorder, and reports one error without transcribing partial audio.
- Mac microphones listed with an FFmpeg context prefix now appear in Micme’s device inventory and picker with their original IDs.
- Windows recording now preserves the exact spacing in a discovered DirectShow microphone name whether you select it or use automatic discovery.
- Automatic Windows microphone discovery no longer blocks Pi’s UI or delays shutdown, and device-selection defaults are unchanged.
- On Linux, the almost-silent audio diagnostic now directs users to MICME_PULSE_SOURCE to select their microphone.
- Clip transcription now reports an error instead of hanging when a hook leaves a writerless FIFO as its transcript output.
- Micme no longer pastes or auto-submits a truncated stdout transcript and still uses a complete transcript file when one is available.
- Micme no longer drops the start of a completed transcript frame when the same output chunk also completes another frame.
- Micme now strips C1 terminal sequences before pasting or sending transcripts to Pi.
- New kept recordings on POSIX are private from creation, even under an existing public recordings root.
- On POSIX, saving Micme configuration now creates missing directories with owner-only permissions, even under a group-friendly umask.
- Micme now checks long streaming transcript frames for overlapping words in linear work without changing which words appear in the editor.
- Windows recording and transcription hooks now preserve literal paths such as `%USERNAME%` without forcing a different expansion mode on Raw placeholders.
- Saving a setting preserves the exact spelling of unrelated JSON numbers, or leaves the file unchanged if a number would be lost.
- Changing Keep audio during recording no longer deletes a clip started as kept or retains one started as temporary.
- Settings now skips discovery and refuses model downloads when the configuration is invalid, while still showing where to repair it.
- Kept recordings now ignore files and out-of-range directory numbers when choosing the next recording directory.
- A writerless config FIFO no longer blocks Pi startup or settings saves; Micme rejects it without replacing it.
- Micme warns when recording cleanup fails and shows the surviving directory through `/micme audio` without losing or redelivering the transcript.
- Stopping or shutting down one Pi session no longer freezes the recording clock in another.
- Stopping after the recorder has already exited now reports an unexpected exit instead of transcribing partial audio, even if a helper keeps the output pipe open.
- The npm-installed micme-doctor command now runs on Node 22.19 without TypeScript stripping.

## [0.3.9] - 2026-11-24

- Windows recording and transcription hooks now launch the system command interpreter rather than a same-named executable in the project directory.
- Micme reports failed signal escalation instead of treating a still-running recorder as stopped or letting a second signal error go unhandled.

## 0.1.0 - 2026-06-18

Initial publication-readiness candidate.

- Adds a pi package manifest that loads `./src/extension.ts` from the package root.
- Provides local clip-mode transcription with `ffmpeg`, `whisper.cpp`, optional Python `whisper`, and advanced custom command hooks.
- Adds experimental streaming preview support through `whisper-stream`.
- Adds `/micme`, `/micme conf`, `/micme devices`, `/micme last`, `/micme audio`, and `/micme help`.
- Documents beginner install, privacy/security behavior, diagnostics, and maintainer publishing steps.

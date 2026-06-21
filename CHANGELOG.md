# Changelog

All notable changes to Micme will be documented in this file.

## Unreleased

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

## 0.1.0 - 2026-06-18

Initial publication-readiness candidate.

- Adds a pi package manifest that loads `./src/extension.ts` from the package root.
- Provides local clip-mode transcription with `ffmpeg`, `whisper.cpp`, optional Python `whisper`, and advanced custom command hooks.
- Adds experimental streaming preview support through `whisper-stream`.
- Adds `/micme`, `/micme conf`, `/micme devices`, `/micme last`, `/micme audio`, and `/micme help`.
- Documents beginner install, privacy/security behavior, diagnostics, and maintainer publishing steps.

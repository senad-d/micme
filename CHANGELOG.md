# Changelog

All notable changes to Micme will be documented in this file.

## Unreleased

- Keep publication on hold until package name, metadata, security review, validation, and smoke tests are complete.
- Use the `docs/PUBLISHING.md` checklist for the first npm release.

## 0.1.0 - 2026-06-18

Initial publication-readiness candidate.

- Adds a pi package manifest that loads `./src/extension.ts` from the package root.
- Provides local clip-mode transcription with `ffmpeg`, `whisper.cpp`, optional Python `whisper`, and advanced custom command hooks.
- Adds experimental streaming preview support through `whisper-stream`.
- Adds `/micme`, `/micme conf`, `/micme devices`, `/micme last`, `/micme audio`, and `/micme help`.
- Documents beginner install, privacy/security behavior, diagnostics, and maintainer publishing steps.

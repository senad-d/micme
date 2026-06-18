# Contributing

Thanks for helping improve Micme.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Use the issue templates for bugs, feature requests, and documentation fixes.
- Do not post secrets, private transcripts, raw audio, or machine-local paths unless they are sanitized.
- Report security issues through the process in [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Micme requires Node.js `>=22.19.0`.

```bash
npm ci
npm run validate
```

Useful commands:

```bash
npm run typecheck
npm run check
npm run check:pack
npm run pack:dry-run
npm run doctor
```

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update documentation when commands, settings, packaging, or security/privacy behavior changes.
- Run `npm run validate` before requesting review, or explain why it could not be run.
- Link related issues with `Closes #123` or `Refs #123` when applicable.

## Security and privacy expectations

Micme can access the microphone, spawn local processes, write `MICME_*` settings, and optionally download model files. Treat changes in these areas as security-sensitive and document any new risks or mitigations.

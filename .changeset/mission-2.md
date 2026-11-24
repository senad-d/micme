---
"@senad-d/micme": patch
---

Stopping recording, cancelling transcription, or timing out now cleans up owned hook workers without hanging on inherited pipes, while preserving graceful recorder shutdown.

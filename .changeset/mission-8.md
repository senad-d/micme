---
"@senad-d/micme": patch
---

Stopping after the recorder has already exited now reports an unexpected exit instead of transcribing partial audio, even if a helper keeps the output pipe open.

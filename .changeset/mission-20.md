---
"@senad-d/micme": patch
---

Micme now accepts a custom FFmpeg recorder’s exit code 255 after Micme sends SIGINT, while still rejecting a recorder that already exited with 255.

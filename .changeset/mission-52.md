---
"@senad-d/micme": patch
---

On POSIX, saving Micme configuration now creates missing directories with owner-only permissions, even under a group-friendly umask.

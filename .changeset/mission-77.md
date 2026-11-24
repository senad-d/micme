---
"@senad-d/micme": major
---

Kept recordings are protected against root substitution; on macOS and Linux without usable procfs, custom hooks now run in the recording directory and must use absolute paths for project-relative tools or resources.

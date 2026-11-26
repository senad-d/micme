---
"@senad-d/micme": patch
---

Defer loading the legacy upstream Pi TUI until Micme needs it for UI, and keep it out of the literal extension import graph. This is a candidate for the Oh My Pi 19.2.0 loader rejection (#151), verified with upstream Pi 1.6.0 only; it does not establish Oh My Pi runtime compatibility.

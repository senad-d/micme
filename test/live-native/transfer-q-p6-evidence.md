# P6: local history and retention in Pi

Functional evidence only, from real Pi 1.6.0 sessions in isolated Linux x64 PTYs at 40 and 80 columns. The launcher supplied a disposable home, project, agent directory and audio sink, and blocked outside network access. Recovery used the public [JFK fixture](README.md#corpus-attribution-and-frozen-reference), replayed by a close-only recorder; no microphone was opened. The full recovery and retention sequence ran against the Micme TypeScript sources (`history-view.ts` SHA-256 `f41b3132f4d8c52e6290459fd7c86815126018695093e8acb2dd30a70dd347f5`). FFplay ran with SDL's dummy output. Retry and the successful dictations used a real local whisper.cpp executable (SHA-256 `40e7b2cd455c9a4fc8e412da781492f73b08be0d6557207ba2e6f20e83657413`) and `ggml-base.bin` (SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`). The view did not observe the bound compute device. There is no paired timing, clipboard readback, physical audio-output or cross-platform claim.

## H1 — recovery

- With history off, opening `/micme history` did not create a database; enabling from the confirmation still left storage absent until the first take. An intentional failing recognizer left a durable `asr-failed` row with a 352,078-byte saved WAV, SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` (the original public fixture). A fresh Pi process at each width found the same row and bytes.
- FFplay launched at 0 s, stopped for a seek to 1.25 s, stopped on demand, and exited successfully on a separate seek to 10.75 s. The first retry reached `recognizing` and was canceled without saving text. A second retry with the now-current installed model saved recognized JFK text under the original row ID, without dictating or replaying into the editor.
- A supplemental run on the delivered view (`history-view.ts` SHA-256 `acdba53b31d68c779d33e7a932314ff4839b89e131f1d2724bf7244eae6ca96c`) recovered a seeded verified live take at both widths with a deliberately missing live worker. File retry used the selected installed whisper.cpp model and left the editor untouched.
- A separately seeded text-only failed-delivery row offered Original, Local and Polished independently and no audio actions. Opening text did not trigger copy in the component test; Enter during Original and Polished in Pi emitted OSC 52 with the exact selected UTF-8 string. The host reported a copy request, not a verified clipboard write. The unavailable-clipboard path kept a long transcript scrollable for manual selection in the component test. Real recovery and copy, with auto-submit on, emitted zero editor API writes, sends or queues. A fixture Pi shortcut opened the same overlay over a draft with a mid-line cursor; after Esc, typing `Z` produced `draft-preserZved` from `draft-preserved`.
- Replacing a library WAV left the text accessible but disabled playback and retry; confirmed deletion could not delete the replacement and reported a storage error. A deliberately non-private library directory produced a storage read failure, not an empty-history message.

Recovered take detail at 40 columns, from the terminal frame:

```text
clip · Recognition failed
2026-11-27 12:58 UTC · Language unknown
Verified saved audio
→ Play saved audio
  Seek…
  Retry with current model…
  Star take
  Delete take…
  File / model details
↑↓ select · Enter open · Esc back
```

## H2 — confirmed retention

- The store contained five rows before confirmation, including a star and a seeded import, despite a configured `count:1` proposal. The preview exposed two exact IDs and 352,078 bytes. Cancel preserved both rows and the WAV. Explicit Apply removed those two rows and the corresponding owned WAV.
- Two more actual Pi dictations, without revisiting retention settings, kept only the newest eligible dictation and its WAV, plus the star and seeded import. The same three rows and WAV leaves survived restart. A confirmed `days:3` policy with zero immediate candidates later expired a backdated eligible row and its WAV on enabled Pi startup, without another take or history command. The star and import survived. Explicitly deleting the import removed its row and library WAV; the public source bytes were unchanged.

Prune confirmation at 40 columns, from the terminal frame:

```text
Apply retention: count:1?
Delete 2 take(s) and 352078 bytes of
saved WAV. The confirmed limit also
applies after this preview.
→ Cancel
  View affected take IDs
  Apply retention
↑↓ select · Enter open · Esc back
```

## Scope of import observations

At both widths, real `/micme import` accepted a two-line paste containing spaces and `$2`, listed the installed model, and presented the exact file paths and fixed model for confirmation. The form was canceled before queuing. The P6 checkout still used the import service shell; job status, progress and cancellation were exercised at the component boundary only. These are not P7 media-decoding or import integration results.

The component and storage checks are in `test/history-view.test.mjs` and `test/take-storage.test.mjs`. The real-terminal observations used the disposable launcher in `test/live-native/transfer-pi-local.mjs`, public audio replay, and direct comparisons of the SQLite rows and SHA-256 of the library WAV leaves.

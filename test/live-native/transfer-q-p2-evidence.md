# P2 Pi take lifecycle: functional checks and frozen replay gaps

## Paired replay

The [P1 manifest](transfer-p1-manifest.json) is unchanged (`d7ed1856d22869925c07f847fe34d34c819429279d5a5d85ce54d15f16e5d367`). The P2-only code tree had no landed commit at collection, so the private run copy cleared only `commit` on `micme-current` builds, in both `products` and the matching trial `build` records. Its SHA-256 was `8f43b752c59598a2ae86ca2aec8ceb032b068057bd738684ab39d6a1d7e5557f`. The checkout's source-byte receipt (`transfer-pi.mjs --source-sha256`) was `416fe4df519fea68029b2b9f560bbde9ba214fd01080c5d31fb1d82f50df460e`. It is not a commit or a native executable hash. Repeats, ordering seed, identities of the other products, fixture digests and the original calibration were not retuned.

`npm run test:live-native -- --transfer MANIFEST OUTPUT` collected the same 300 planned slots with byte-identical [attempt ledgers](transfer-q-p2-takes.jsonl) (`685bbe7bd1385174373f74c4b26d629ee2fb9548e0dda6a3711588c4b05f1d67`). The private sidecar supplied the lockfile Pi host and P2 source path only. No desktop instance, physical microphone or network-backed ASR was activated.

| Outcome | Frozen P1 | P2 replay |
| --- | ---: | ---: |
| Planned | 300 | 300 |
| Triggered and completed | 0 | 0 |
| Failed / timeout / lost | 0 / 0 / 0 | 0 / 0 / 0 |
| Unavailable at preflight | 300 | 300 |
| Timing calibration | 120 attempts unavailable, no tolerance | Unchanged |

All 60 Handy slots needed the isolated release and runtime, exact public fixtures and model. The 21 released and 100 historical Micme slots needed their corresponding checkouts and per-product receipts, not the P2 worker. Of 119 candidate slots, 115 lacked the landed candidate commit and receipt; those also need separately pinned Worker v1/comparator, exact weights and prepared WAVs. Three language-control inputs still lack a pinned public PCM. The physical input slot still requires separate consent and an isolated observer.

There are no matched timings for trigger → samples → ready or stop → correct target; no native delivered-text evidence for missed onset/tail; and no triggered-take failure rate. Counts of zero triggered failures do **not** establish a zero failure rate. The [frozen P1 evidence](transfer-q-p1-evidence.md) has no finite before measurements, so a later provisioned candidate alone cannot close these gaps. No pair or tolerance was manufactured. Use the [provisioning and replay guide](README.md#rerun-the-frozen-comparison-v1) for a separately calibrated native comparison.

## Functional checks (not native timing)

- **C1:** The lifecycle tests `clip recorder startup without bytes` and `delayed live PCM` held back the first block. The live zero block produced one readiness transition before the first feed; two blocks produced two feeds totaling exactly 200 samples and FINISH at 200. The close-only custom SIGINT recorder exited 255 on two successive takes, each pasting once with auto-submit off and no sample-ready cue. A recorder that exited with partial audio did not render a recording widget or deliver a transcript.
- **C2:** The widget test `opaque recorder status` verified that a custom source neither opens a meter file nor claims a device or channel. Requested input is not observed hardware binding; physical input, reconnect and fallback behavior remain unverified.
- **C3:** `live decoder death before ACK` exercised the real recorder/decoder process lifecycle with fixture executables: the verified recovery WAV retained the exact sent-but-unacknowledged prefix and the four stop-time tail bytes. RPC cancel at that boundary created no snapshot or editor/send output. These are PCM ownership checks, not recognized-word coverage.
- **C4:** [Real isolated Pi PTY replay at 40/80 columns](transfer-q-p2-pi-replay.txt) rendered advancing drafts before commits, kept the public prefix on stop, and showed explicit replay after a Left Arrow redraw, with no sends or queues. ASR was scripted. Scripted elapsed values are not native comparison samples. This is a terminal extension; no browser page or visual desktop overlay was involved.
- **Review:** The installed-Whisper CLI contract was exercised with fixture executables and a local sample/close-only mic hook. Both showed review outside the prompt even with auto-submit on; the previous ordinary replay was unchanged. This does not qualify native Whisper output, later setup UI, optional recognition, history storage, providers or hooks.

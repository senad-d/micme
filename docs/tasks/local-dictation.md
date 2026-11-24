## Request coverage

| Request or additional mechanism | Delivery / why needed |
| --- | --- |
| “examine how micme is utilizing local models and assess their effectiveness” | [Assessment](../research/local-dictation.md); Task 7 measures native quality and latency against the same-model clip baseline. |
| “performance and configuration are lacking and need significant improvement” | Tasks 2–4 and 6: one loaded model, one input, no ASR on silence, overrides that actually affect the selected backend. Task 7 measures, rather than assumes, a speedup. |
| “similar apps using comparable technologies operate much more smoothly” | [Comparison](../research/local-dictation.md#what-comparable-tools-do); Tasks 2 and 5 apply speech gating and separate tentative from final output. No named app, visual clone or performance parity claim. |
| “streaming … produces totally unrelated text … investigate this issue and identify a solution that will make micme functional” | Tasks 2, 3 and 5 remove un-gated inference, mismatched inputs and irreversible guesses. Task 7 tests recognition, not just text suppression. |
| “it must be able to show text while you’re still speaking” | Tasks 2, 5 and 6 deliver changing, speech-gated partials in Pi before silence or stop. User authorized the extra local decoder and speech-detection component. |
| “Plan your work and implement the necessary changes” | This plan and its four designs; Tasks 1–7 deliver the implementation. Clip-only users need no new setup. |
| Buildable `micme-live` helper, private pipe protocol, local VAD weight | Tasks 1, 2 and 4. The existing stream binary cannot accept Micme's samples or report speech/timed hypotheses. No server, hosted API or outside account. |
| Seekable PCM capture and bounded reads | Tasks 3 and 5. Slow inference must not drop audio; a verified snapshot from the held capture gives the existing optional final pass exactly the samples that live inference consumed. |
| A replaceable draft line, separate from committed editor text | Tasks 5 and 6. Gives immediate feedback without permanently inserting guesses. RPC host edits cannot be observed, so live RPC delivery waits for an explicit replay instead of automatically replacing/sending the prompt. |

## Contracts

**Worker v1 (Tasks 1, 2, 4, 5, 7).** Executable `micme-live` (`.exe` on Windows); `--protocol-version` prints `1` + LF and exits 0 without weights. `native/live/main.cpp` owns the probe, otherwise calls `int run_live(int argc, char **argv)` declared in `decoder.hpp` and defined in `decoder.cpp`. Normal argv: `--model PATH --vad-model PATH --language CODE [--translate]`. Paths resolved before any child cwd change. Fixed 16,000 Hz mono signed LE16. No shell, network listener or stdout logs. UTF-8 JSON Lines on stdout, bounded to 64 KiB per line; diagnostics on capped stderr. Worker flushes every event. Version/readiness/load/protocol errors are errors, never words.

- Input frames: byte `1` = feed, `2` = feed without speculative decode (catch-up), followed by uint32LE **sample count** 1..16000 and exactly twice that many PCM bytes. Byte `3` = finish, no payload. Short reads are reassembled; EOF without finish is cancellation, not a successful end. One unacknowledged feed at a time. Absolute sample positions start at zero; `[from,to)` excludes `to`.
- Events: `{type:'ready',version:1,rate:16000,loadMs:number,asrLoads:number,vadLoads:number}` after loading both models; `{type:'partial'|'final',from:number,to:number,text:string}`; `{type:'ack',through:number}` after processing each feed (including any resulting text events); `{type:'done',through:number,asrCalls:number,asrMs:number,vadFrames:number}` after finalizing; `{type:'error',message:string}` then nonzero exit. Types/properties here describe JSON, not literal single-quoted wire text. `through` counts all accepted samples including silence, not recognized speech. Partial replaces the prior draft; empty partial clears it. Final advances the finalized audio frontier, may contain empty text, and clears the draft. Final ranges never overlap; partials cannot supersede a final. Only a valid done for the exact captured count followed by a clean exit completes a requested finish.

**Capture (Tasks 3, 5, 7).** `src/live-capture.ts`: `buildLiveRecorderCommand(audioPath:string, directory:RecordingDirectory, signal:AbortSignal):Promise<CommandSpec>`; `openLivePcm(audioPath:string, directory:RecordingDirectory, signal:AbortSignal):Promise<LivePcmReader>`. `LivePcmReader.read(final:boolean):Promise<{pcm:Buffer,availableThrough:number}>`, `close():void`. Reader cursor implicit, at most 16000 complete samples returned per call; `availableThrough` is total available, not remaining. Empty is temporarily caught up; empty after recorder close and final drain is EOF. Missing/incomplete data on final or malformed input throws; zero-length *valid* WAV means no speech. Normal reads/poll and bounded startup are cancellable. The spool is one append-only PCM payload; only header length fields may be patched at close. Built-in capture owns its optional filter; a custom hook supplies decoder-ready PCM and owns any filtering. No downstream filter in either case.

`LivePcmReader.writeRefinementInput(target:RecordingDirectory, acknowledgedThrough:number, signal:AbortSignal):Promise<string>` returns a completed WAV input path in `target`, **not** the spool pathname. Task 5 passes a fresh operation-owned private temp directory never supplied to the recorder, after recorder tree stop, final drain and matching worker done. Task 3 copies from the still-held leaf into a fresh, exclusively created WAV there with a canonical header; require identical sample count and SHA-256 of payload bytes to those returned by `read` in order (header bytes excluded). Never reopen `raw.wav` for this copy. If the hook replaces its leaf at stop, use the verified original or reject refinement; identical lengths are insufficient. Reject a malformed original, mutated payload or incomplete snapshot before passing any path to a transcriber. Task 5 holds the snapshot directory until transcription/abort completes, then removes it irrespective of keep-audio; no snapshot when refinement is off.

**Resolution (Tasks 4–7).** `src/live-plan.ts`: `resolveLivePlan():{binary:string,modelPath:string,vadModelPath:string,language:string,translate:boolean,finalizeWithClip:boolean}` (throws actionable setup error for unsupported backend/missing executable); `ensureLiveModels(plan:ReturnType<typeof resolveLivePlan>,ctx:ExtensionContext,signal:AbortSignal):Promise<void>`. Paths, policy and UI keys in feature §Data/Compatibility. Task 4 introduces these APIs alongside the old selection code; it must **not** change what `resolveTranscriptionPlan({transcriptionMode:'stream'})`, the active lifecycle, the mode profile or doctor use. Task 5 switches those callers together: the general stream plan projects the new resolver's result/error, doctor reports the same result, lifecycle uses only Worker v1, and `src/config.ts:getTranscriptionModeProfile(mode)` now returns only `{MICME_TRANSCRIPTION_MODE:mode}`. Keep the additive resolver independent of the general stream dispatcher (no recursive resolution).

**Pi view (Tasks 5–7).** `Recording.liveDraft?:string` on the active primary recorder. Only the current operation writes sanitized latest text; empty/undefined means no draft. `RecordingWidget.start(ctx,active)` reads it during its existing 120 ms refresh and renders a `Live:` line below the meter in `micme-recording`; `clear(ctx)` clears both. The field is optional: clip recordings and a live recording before its first partial need no draft. Lifecycle owns commit/delivery and never reads text back from a widget; drafts are neither replayable nor eligible for auto-submit.

## File ownership

| File(s) used by multiple tasks | Sole editor |
| --- | --- |
| `package.json`, native build manifest, package-content check | 1. Own build/pack targets and the entry for the opt-in native quality runner. Own `native/live/main.cpp` (version probe/dispatch), manifest and build guide throughout. Seed `decoder.cpp/.hpp` with the buildable interface placeholder; Task 2 alone fills the decoder implementation after scaffolding. |
| `src/audio.ts`, `src/live-capture.ts`, `src/recording-dir.ts`, `src/windows-recording-dir.ts`, recording-directory tests | 3. Own recorder selection, verified leaf/handle access on both platforms, snapshot creation and reader types. |
| `src/live-plan.ts`, `src/models.ts`, `src/constants.ts`, model and new isolated live-plan tests | 4. Add model/worker resolution and VAD acquisition only; no changes to existing caller selection, profiles or fixtures. |
| `src/extension.ts`, `src/streaming.ts`, `src/types.ts`, `src/processes.ts`, `src/backends.ts`, `src/transcription.ts`, `src/config.ts`, `scripts/doctor.mjs`, `micme.schema.json`, `micme.example.json`, `README.md`, `SECURITY.md` | 5. Own the coordinated resolver/lifecycle/doctor cutover, mode profile, protocol, delivery and migration text. Link the setup guide from 1. |
| `test/backends.test.mjs`, `test/config-contract.test.mjs`, `test/doctor.test.mjs`, `test/packaging/doctor.test.mjs`, stream/lifecycle/process tests | 5. Migrate legacy stream assertions and command fixtures at cutover, not in 4 and not deferred to UI work. |
| `src/settings.ts`, `src/recording-widget.ts`, widget, settings and settings-screen tests | 6. Use shared getters; do not add a second resolver. |
| Native evaluation fixtures/runner under `test/` and its results record | 7. No product logic, native build tree, weights or user recordings in this corpus. |

## Verification

- Run `npm run validate` and `npm run test:pi-contract` on the merged checkout. The packaging checks named in Tasks 1 and 5 are outside the default test glob: run `npm exec -- node --test test/packaging/check-package-contents.test.mjs test/packaging/doctor.test.mjs` separately (the fresh-install check can need registry access). Use the available host, not native Windows tests.
- After explicit one-time worker/weight setup, start the checkout with **`pi -e .`** and local seeded public speech (real-time WAV capture hook) or the selected microphone. No Pi provider login or network for dictation. Select stream, speak continuously, **observe changing recognizable words before any pause or stop**, then pause, resume, stop and review. In TUI check prior editor text and `/micme last`; auto-submit only on successful completion when enabled and no detected insertion. In write-only RPC verify the live view, saved result and no automatic editor write/send, whether or not the host edited. A stop-only transcript fails.
- Repeat with the same microphone/file for optional final refinement, no speech, a real short acknowledgment, user edits, `/reload` mid-decode and a missing model. No draft leaks, second capture, late writes, lost tail, false auto-submit or orphaned processes.
- Run the opt-in **native** measurement journey in Task 7 against the hardening targets: speech and nonspeech, same WAV/model on clip and live, then base.en vs small.en. Report the post-clipping visible-draft relevance gate separately from latency and final WER. If no declared configuration passes the combined native gates on the reference host, the delivery fails; a perfect final does not rescue unrelated live text. Missing prerequisites or an unavailable physical mic are reported as such, never a native pass based on mocks. No Windows run required.
- Exercise the settings and draft at normal and narrow widths in the TUI; confirm displayed input, language and model agree with doctor and actual process arguments. In RPC, check the supported string-array widget updates and explicit replay, not the custom settings screen.

### 1. Make the offline worker buildable and installable

- [ ] Supply the build/pack scaffold and an explicit local setup route for `micme-live` without changing how a clip-only install starts.

#### Why

Micme's npm package contains TypeScript and doctor but no decoder binary. A design that works only in the source checkout is not usable by its current users.

#### References

`docs/specs/local-dictation-feature.md#target-behaviour` — provisioning, pin and offline constraints.

`docs/research/local-dictation.md#what-whisper-stream-actually-supplies` — pin and unsuitable SDL target.

#### How

Depends on: none. Create the `native/live/` skeleton (CMake manifest, entry point, decoder header/source placeholders and conventions/build/test instructions). Build against pinned whisper.cpp `96ec4d9823e9d0211944172da35f9f29134af990`; no SDL, HTTP server or microphone dependency in the helper. Implement the **Worker v1** version probe and dispatch into the decoder translation unit; never claim readiness in the stub. Document compiler/CMake prerequisites, reproducible source pin, installation on PATH or explicit `MICME_LIVE_BIN`, and offline build from pre-provisioned upstream sources. Include exact source/build files in npm pack, not a recursive build tree. Provide native build/install scripts or targets and the opt-in runner entry `test:live-native` for `test/live-native-quality.mjs`.

#### Where

`native/live/`

`package.json`

`scripts/check-package-contents.mjs`

`test/check-package-contents.test.mjs`

`test/packaging/check-package-contents.test.mjs`

#### Acceptance criteria

- From the packed sources on a supported host, explicit setup builds a worker whose no-model version probe returns 1. The build guide includes how to build/test it and where new worker files belong.
- Normal install, Pi startup, doctor and clip tests do not require CMake, weights, network or the worker. Pack guard includes build inputs, excludes weights, audio and local build products.

### 2. Recognize speech with a resident decoder

- [ ] Decode the incoming PCM locally and produce replaceable text during continuous speech, not only after a pause.

#### Why

Upstream terminal redraws have neither Micme's microphone samples nor a reliable commitment boundary. Ads for a faster model cannot repair that protocol.

#### References

`docs/specs/local-dictation-feature.md#target-behaviour` — gate, timing, bounded windows, endpoint/stop and language rules.

`docs/specs/local-dictation-hardening.md#target` — counts, native responsiveness and accuracy gates.

`docs/research/local-dictation.md#what-comparable-tools-do` — pinned C API and speech-gated comparisons.

#### How

Depends on: Task 1. Implement **Worker v1** in the scaffold. Load whisper.cpp ASR and Silero once; use stateful VAD probabilities, fixed-rate additional-audio scheduling, timestamped window ownership and deterministic endpoint/finish. Use private standard pipes in binary mode where needed; ancillary diagnostics must never become words. Instrument per-operation counts/timings as specified in the protocol. Keep memory bounded independent of recording duration; ASR never processes whole-session silence or repeatedly reloads weights.

#### Where

`native/live/`

#### Acceptance criteria

- Valid model load emits ready; silence feeds ack without text/ASR. A paced voiced case emits changing partials **before endpoint/finish** and one ordered final per finalized span. Forced rollover neither repeats nor loses a boundary word in the reference case. Exercise >28 s of gate-open PCM with no segments/timestamps: the deterministic 20 s empty final advances the frontier, releases overlap and permits later speech exactly once with complete sample counts. Nonempty unplaceable text at the cap fails explicitly (feature §Target behaviour).
- One active decode, one model load per kind. Backlogged feeds still update VAD and finalize speech; short final blocks do not add or lose samples. Malformed, truncated or incompatible input and failed inference exit explicitly, not as a successful empty transcript.
- Language and translation reflect the selected compatible weight; valid acknowledgments, Unicode and repetitions are not filtered by a phrase blacklist.

### 3. Read one microphone continuously without losing samples

- [ ] Supply the configured recorder and a seekable live PCM reader that can catch up without reopening the microphone.

#### Why

A stream that hears a different input from the clip, reads WAV metadata as audio or loses samples when decoding is slow can never be meaningfully compared to the clip.

#### References

`docs/specs/local-dictation-feature.md#target-behaviour` — single capture, filter, format, safe reads and drain.

`docs/specs/local-dictation-bug.md#cause` — separate device namespaces.

`docs/specs/local-dictation-hardening.md#target` — full coverage under lag.

#### How

Depends on: none. Implement **Capture**, sharing FFmpeg OS-input selection with `buildRecorderCommand` without changing clip commands. Flush worker-compatible WAV promptly to the owned directory; preserve trusted hook placeholders. For the held reader and snapshot:

POSIX: nonblocking, no-follow leaf open through the owned directory, verify regular by descriptor. Windows: keep the existing ancestor locks, including equivalent verified directory access for a live temp spool. Open the existing `raw.wav` leaf with `CreateFileW` and `FILE_FLAG_OPEN_REPARSE_POINT`, allow the recorder's read/write sharing, and inspect that **same handle** (`GetFileType` disk; attribute/tag info rejects reparse points and directories). Retain it for size, positional reads and snapshot. Close exactly once. If access, locks or verification cannot be established, refuse live capture with a clip/setup hint; no `openSync(path, O_NOFOLLOW)` fallback on Win32. Never block Pi waiting for a growing file; cap reads, chunk scans and polling.

#### Where

`src/audio.ts`

`src/recording-dir.ts`

`src/windows-recording-dir.ts`

`src/`

`test/recording-dir.test.mjs`

`test/audio-recorder.test.mjs`

`test/`

#### Acceptance criteria

- Same selected device string as clip; one file output, no SDL, second mic, unrequested meter pipe or duplicate filter. An FFmpeg fixture writes readable samples at real time, not all at close.
- A growing WAV with ancillary chunks, partial headers/samples and a patched final length yields each PCM sample in order exactly once. Reader catches up from disk after delay; rejects invalid format/truncation, stops polling on abort and never opens a replaced display path.
- An injected Windows handle boundary rejects reparse, directory, non-disk and unverifiable leaves without reading them, and reads only the verified handle on success. Keep ancestor locks; no native Windows run is required.
- A custom hook emits append-only decoder-ready PCM; replacing `raw.wav` with different same-length samples at stop cannot substitute those samples in `writeRefinementInput`. Copy the accepted payload from the held handle or reject. A same-inode payload rewrite also fails digest verification. No unverified snapshot reaches a caller.
- Built-in enabled/disabled filtering applies one/zero configured filter passes; raw and pre-filtered custom hooks get zero extra passes in live or refinement. Existing clip defaults, hook quoting, validation, meter behavior and device selectors still pass.

### 4. Add an isolated worker and model resolver

- [x] Resolve and provision the new local worker/weights through a separately testable API without changing the engine an existing recording starts.

#### Why

A working model file is not enough if the wrong executable, VAD artifact, microphone namespace or mode-specific profile is selected.

#### References

`docs/specs/local-dictation-feature.md#data` — effective keys, defaults, artifact identity and acquisition.

`docs/specs/local-dictation-feature.md#compatibility` — legacy values and clip behavior.

`docs/research/local-dictation.md#model-choice-and-measurement` — language/model tradeoffs and baseline.

#### How

Depends on: none. Implement the additive **Resolution** API for **Worker v1** in `src/live-plan.ts` using the existing config accessors. Resolve without opening a mic, loading weights or downloading; only the explicit ensure call acquires weights. Pin the standard VAD file to its official upstream revision/digest, check it before cache publication, and reuse shared transfer, timeout, cancellation and cleanup rules. Keep VAD out of ASR discovery. Preserve translation mapping, reject known incompatible explicit pairs and resolve auto with English-only weights to English. Do not wire the new API into the active dispatcher, extension, settings or doctor. The old stream fixtures and SDL protocol must still work at the end of this task, even with `micme-live` installed.

#### Where

`src/constants.ts`

`src/models.ts`

`src/`

`test/models.test.mjs`

`test/`

#### Acceptance criteria

- Direct tests of `resolveLivePlan` agree across JSON/environment defaults and respect explicit worker, ASR/language and VAD paths. Unsupported backend, missing executable and incompatible model give actionable errors. No mic, inference, download or writes during resolution.
- Model ensure handles missing custom VAD, bad digest, download disabled, cancellation, shared acquisition and nonregular files safely. No network for cached assets. Clip model behavior remains intact.
- With both binaries available, the new API selects `micme-live` in isolation; the unchanged active runtime/doctor still select `whisper-stream` for SDL streaming. Only the next coordinated cutover changes that behavior.

### 5. Switch recording and doctor to the worker protocol together

- [ ] Replace SDL spawning/ANSI parsing with one owned worker, one configured recorder and a guarded draft/commit lifecycle.

#### Why

The decoder and capture only solve the reported bug if the recording session feeds every sample, exposes timely partials and never sends a superseded guess.

#### References

`docs/specs/local-dictation-bug.md#regression-checks` — false commits, valid short speech and single-input invariants.

`docs/specs/local-dictation-feature.md#failure-cases` — startup, abort, partial audio and final-pass outcomes.

`docs/specs/local-dictation-feature.md#compatibility` — staged setting migration, filter ownership and per-mode delivery.

`docs/specs/local-dictation-interface.md#states` — what Pi may show/send in each phase.

#### How

Depends on: Tasks 2, 3, 4. Activate the implemented worker, not its version-probe scaffold. Cut over **Resolution**, **Worker v1**, **Capture** and **Pi view** in one change: switch `backends.ts`'s general stream projection and doctor to the additive resolver **when removing** `resolveStreamingTranscriptionPlan` → `buildWhisperStreamCommand`/SDL spawning in `extension.ts`. Migrate re-exports, doctor option injection and active lifecycle/config/backend fixtures in that same change. No caller ever invokes `micme-live` with SDL arguments. Probe/report availability without capture/download; distinguish it from actual worker model readiness. Keep clip resolution unchanged. Test with a local protocol stand-in independent of native runtime availability.

Switch the saved mode profile to mode-only, deprecate ignored keys in schema/example, document worker/VAD setup, JSON/env overrides, RPC replay behavior, migration and model-download provenance in README/SECURITY. Retain any legacy read accessors still imported by the pre-Task-6 picker until its imports can go away; they do not drive stream execution. Replace `test/config-contract.test.mjs`'s retired stream command imports and assertions for SDL-only picker values with checks of the active runtime/schema contract here. Do not assert either the old or the future UI layout in that shared test; Task 6 owns picker assertions.

Launch the child with binary-writable stdin and bounded, incrementally decoded stdout; keep stderr separate and sanitized. Do not use a recorder stop string as PCM. Track worker and recorder distinctly (primary is the recorder, never inferred from insertion order); observe unexpected exit of either even with inherited pipes open. Await ready before recording, guard all callbacks, and poll/read to acknowledged position. If more than one block behind, suppress only superseded previews; restore normal preview as soon as caught up. Never wait for a pause to deliver a partial.

On stop, close recorder normally, drain the held reader, finish and check done/count/exit. For requested refinement of speech, call `writeRefinementInput` before closing the reader. Invoke the selected clip backend on that verified private WAV (existing validation as applicable), **never** on the recorder's pathname and never run clip preprocessing again. No snapshot on silence; on verification/refinement failure keep confirmed live text available, warn and do not replace or submit. Retire frame parsing, quiet flushes, false meter and unconfirmed fallback. TUI keeps its observed-insertion guard, spacing and eligible auto-submit. Write-only RPC shows drafts via widget and remembers the completed transcript, never auto-writes or auto-sends it; distinguish an explicit `/micme last` action from an automatic write. Retain directory ownership and failure cleanup. Bound hung ready/ack/finish; cancel both child trees, not just the promise awaiting them.

#### Where

`src/extension.ts`

`src/processes.ts`

`src/types.ts`

`src/streaming.ts`

`src/backends.ts`

`src/transcription.ts`

`src/config.ts`

`scripts/doctor.mjs`

`micme.schema.json`

`micme.example.json`

`README.md`

`SECURITY.md`

`test/backends.test.mjs`

`test/config-contract.test.mjs`

`test/doctor.test.mjs`

`test/packaging/doctor.test.mjs`

`test/streaming.test.mjs`

`test/extension-lifecycle.test.mjs`

`test/processes.test.mjs`

#### Acceptance criteria

- With both binaries installed, runtime and doctor agree on the worker, model, VAD and language; lifecycle fixtures reject SDL argv and require Worker v1 ready/finish. With only `whisper-stream` available neither lies about readiness nor starts it. The packaged doctor passes its own check; clip priority, custom/Python and cached/offline behavior stay intact. Mode changes write only the mode; overrides and stored legacy keys survive.
- Before endpoint/stop, two disjoint partials replace `Recording.liveDraft`; only finalized ranges count toward the transcript. Clean UTF-8 framing works; malformed, oversized, out-of-range or stale events never type. TUI handles legitimate repeated/short phrases, retains observed additions and suppresses replacement/auto-send after such an edit.
- Exercise RPC with a write-only adapter: `getEditorText()` always empty, paste replaces, host buffer tracked **by the test only**. Edit that buffer after the first final, with auto-submit both on/off; no later automatic set, paste or send. Explicit replay during recording is the only authorized replay write/send and is not undone. On success advise how to retrieve the saved transcript and what explicit replay will do.
- Stop includes the last partial block. A hook replacing its WAV with different same-length PCM on stop cannot supply the final backend's input: consume the verified snapshot or warn before replacement/send. Verify zero extra filters for raw and pre-filtered hooks and no second pass on built-in filtered audio. No-speech, refinement failure and user-edited TUI do not auto-submit.
- Slow model, repeated toggle, primary/worker startup and spontaneous exit (even code 0), shutdown while loading/inference/finalizing, nonempty partial audio and controller/descriptor cleanup have bounded, observable outcomes. No late writes/children/timers after shutdown. Clip-only behavior remains unchanged.

### 6. Show live words and configure the actual microphone

- [ ] Render a replaceable draft while speech is in progress and expose only settings that apply to the new live path.

#### Why

The running UI currently offers an SDL capture id and ineffective VAD slider beside a separate microphone picker. A live draft must be visibly different from submitted or committed text.

#### References

`docs/specs/local-dictation-interface.md#target-screens` — changes within existing panes/widget.

`docs/specs/local-dictation-interface.md#states` — tentative/committed, empty, editing, error and shutdown.

`docs/specs/local-dictation-feature.md#compatibility` — OS input bindings and preserved controls.

`docs/research/local-dictation.md#evidence-from-the-running-app` — observed baseline and fixture limitations.

#### How

Depends on: Task 5. Build against **Pi view** and **Resolution**: the widget is a consumer of an optional field; settings consume the existing config/plan API, not the decoder. Show latest bounded, terminal-safe Unicode draft, no focus or editor write. Fix Linux's device binding to `MICME_PULSE_SOURCE` default `default`, retain macOS/Windows selectors. Keep candidate cycling for known microphones. Show effective worker/VAD paths and their config keys; for arbitrary paths or an unlisted Pulse source, point to the `micme.json` shown in the header (or shell overrides) and restart Pi. Existing rows do not accept arbitrary text. No new discovery, file browser or input widget. Bind the remaining final-pass and diagnostic switches, remove false tuning/profile claims, and distinguish clip-only settings, environment overrides and custom recorder. Do not introduce a new screen.

#### Where

`src/recording-widget.ts`

`src/settings.ts`

`test/recording-widget.test.mjs`

`test/settings-screen.test.mjs`

`test/settings.test.mjs`

#### Acceptance criteria

- Injecting two drafts overwrites the first on the next widget refresh, without touching editor/status ownership. An empty/cleared state leaves no `Live:` label; clear/stop removes the widget. Long/wide text remains readable at a narrow width without changing the final transcript.
- A user can select the actual OS recorder input and locate the live worker, VAD and ASR selection without searching for SDL ids. Mode change writes only mode; current model, input, final-pass and explicit settings survive. No UI claims a missing binary/model is ready.
- Starting with only Linux `default` discovered, set an unlisted `MICME_PULSE_SOURCE`, `MICME_LIVE_BIN` and `MICME_VAD_MODEL` with a space in the paths in the indicated config file. On fresh load the displayed values/plan and actual recorder/worker argv use those exact values; shell overrides take precedence. Existing navigation, AVFoundation overrides, exact DirectShow names, malformed-config repair and clip-only settings stay usable.

### 7. Measure recognition and live latency on matched audio

- [ ] Deliver and run a reproducible, opt-in native quality experiment; record what this host can actually recognize in time to be useful.

#### Why

A commit-policy fixture can prove that Micme handles a correction, but cannot tell whether a local model heard the words or did so while the speaker was still talking.

#### References

`docs/specs/local-dictation-hardening.md#baseline` — verified/source-only starting evidence.

`docs/specs/local-dictation-hardening.md#target` — correctness, time and coverage gates.

`docs/specs/local-dictation-hardening.md#proof` — paired runs, corpus, controls, required measurements and evidence limits.

`docs/research/local-dictation.md#model-choice-and-measurement` — fixed speech source and model comparison rationale.

#### How

Depends on: Task 6. Create `test/live-native-quality.mjs` (not a default `.test.mjs` download/inference job), its fixed, licensed inputs or deterministic preparation recipe, references and results record under `test/`. Use the real extension lifecycle + widget, **Capture**, **Resolution**, **Worker v1** and **Pi view**; a test context may observe clocked UI writes but must not synthesize ASR output. Pace the same WAV through a trusted local recorder fixture so speech rather than file read speed controls timing. Baseline with a real whisper.cpp clip decode of the identical file/model. Keep assets/weights outside the shipped package. Document exact local setup and invocation, scoring and replay, and make measuring a *different* machine or weight straightforward.

#### Where

`test/`

#### Acceptance criteria

- On the reference host run the provisioned native paths and save the actual outcome for each hardening target, including failures. Record host, binaries/weights, approved public data/provenance, reference vs recognized text, latency distribution, WER by case, call counts, sample coverage and optional physical-mic limitations. Test both base.en and small.en to make an evidence-based tradeoff recommendation; no silent global model switch.
- Independently gate the actual post-clipping drafts on the timed reference as specified in hardening §Proof. The scoring fixture with a growing correct prefix, eleven unrelated trailing words and a perfect final must fail; a short correction need not. Report per-checkpoint visible text, relevance pass/fail by run/width/configuration, latency and final WER separately. If neither reference configuration passes the combined gates, delivery fails: identify the first divergence and its repair owner, then rerun without moving the thresholds. Negative controls check *all* drafts as well as final text. Positive controls prevent winning by suppressing quiet/short speech. Distinguish deterministic correctness, matched native inference and an actual microphone run in the report.
- A deliberately invoked evaluation with missing native prerequisites is not green. Normal unit/pack checks stay offline. Do not describe an unexecuted legacy SDL, multilingual, accelerator or hardware case as a measured improvement.

## Decisions

- Work kinds: **bug**, **feature**, **hardening** (recognition cost/latency), **interface**. This is one delivery for an existing extension, not a new app or a change to Pi/runtime versions.
- Choose the user's live-during-speech option: one local resident decoder plus acoustic speech detection. Reject both pause-only phrase batching and a legacy output-parser patch: neither can deliver correctable feedback from the configured microphone throughout continuous speech.
- Start from the current `small.en` choice and compare `base.en` on the same signal. A larger model can still hallucinate on silence; published benchmark speeds do not establish local dictation accuracy. No cloud fallback or new accounts.
- Use an explicit worker build/install, not a mandatory install script, a local HTTP service or a binary release pipeline. Optional clip refinement is retained, but cannot count as proof of working live recognition.

## Open questions

No product decision blocks the plan. Actual model quality, latency/compute on the reference host, and whether the original user's SDL microphone was wrong remain unverified. The running UI and pinned upstream behavior were examined; no native Whisper inference was available at planning time. Task 7 resolves the measurable questions; attribution to the user's device requires a matched signal there. See the four designs' Open questions for the limits of each claim.

Plan revision: 2 (objective 134, baseline `f31e368`, user-confirmed live-during-speech direction; clarified cutover, capture/delivery guarantees and visible-draft acceptance).

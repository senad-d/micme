# Pi extension review tasks

## Review identity

- **Target:** `@senad-d/micme` 0.3.5
- **Review mode:** Comprehensive baseline
- **Current target:** Git commit `73cf5dfbb5599c09aaea7c79e2fa72175b3494dc` on `main`; working tree clean at review start
- **Previous baseline:** N/A
- **Primary entry points:** `src/extension.ts`, `scripts/doctor.mjs`, `package.json` (`pi.extensions` and `bin`)

## Vertical-slice coverage

| Slice or shared area | Entry point and execution path | Important scenarios/tests | Status | Notes |
| --- | --- | --- | --- | --- |
| Pi registration, shortcuts, and session lifecycle | `src/extension.ts` default export → `/micme`, shortcut, `session_start`, `session_shutdown` → recording state/process cleanup | Startup, repeated shortcut, overlapping startup, shutdown, stale work, Pi API contract | Reviewed | A controlled overlap/shutdown harness reproduced an untracked process; live Pi reload/switch validation is deferred below. |
| Clip recording and transcript delivery | `/micme`/shortcut → `startRecording` → `audio.ts`/`processes.ts` → preprocessing/validation → `transcription.ts` → `transcript-delivery.ts` | Backend failure, recorder exit, silence, empty transcript, auto-submit, cleanup, kept audio | Reviewed | Unit tests cover adapters; targeted failure harnesses covered late recorder exit and missing volume metrics. |
| Streaming dictation and optional final clip | `startStreamingTranscription` → `models.ts` → `streaming.ts`/`processes.ts` → live preview or final clip → delivery | Overlap/correction/reset frames, quiet flush, duplicate frames, process failure, stop, final-clip fallback | Reviewed | Stream text logic is unit-tested; real `whisper-stream` and microphone behavior were not invoked. |
| Audio-device inventory | `/micme devices` → `audio.ts` platform plan → `ffmpeg` → parser → message renderer/widget | Unsupported OS, missing binary, timeout/error, permission text, control-sequence sanitization, narrow UI | Reviewed | Platform parsers are tested with fixtures; native Windows/Linux device APIs were not available on this host. |
| Configuration UI and global persistence | `/micme conf` → `settings.ts` discovery/screen → `config.ts` read-modify-write → reload | Non-TUI mode, invalid JSON, save, shell override, concurrent writes, close during async work | Reviewed | Concurrent disjoint writes were reproduced losing one update. |
| Backend/model resolution and acquisition | `backends.ts`/`models.ts` → executable/model resolution → optional `fetch` download → transcription/stream startup | Explicit/auto backend, translation fallback, missing model, concurrent download, stream failure, target cleanup | Reviewed | Mock download tests exist; cancellation and timeout ownership are findings. |
| Editor fallback, transcript replay, help, and audio-path commands | `editor.ts` and `/micme last|audio|help` → shared config/delivery/sanitization | Printable/terminal shortcuts, empty replay, idle/busy auto-submit, terminal controls | Reviewed | No separate actionable defect verified in these helper commands. |
| `micme-doctor` diagnostics | `package.json` bin → `scripts/doctor.mjs` → config/backend/model/device diagnostics | Invalid config, missing executables, redaction, translation-aware model resolution | Reviewed | A targeted fixture reproduced a runtime/doctor effective-model mismatch. |
| Package and release validation | npm scripts/CI → syntax, lint, typecheck, tests, pack guard, publish workflow/script | Package allowlist, secret/artifact exclusion, clean-tree/release validation | Reviewed | Destructive or credentialed publish paths were source-reviewed only. |

## Production-source classification

| Paths or bounded glob | Classification | Covered by | Notes |
| --- | --- | --- | --- |
| `src/extension.ts` | Reviewed | Registration/lifecycle, clip, streaming, helper commands | Default export and all registrations traced. |
| `src/audio.ts`, `src/audio-level.ts`, `src/recording-dir.ts`, `src/recording-widget.ts` | Reviewed | Clip recording, device inventory, streaming final clip | Filesystem, platform process, rendering, and retained-audio boundaries inspected. |
| `src/backends.ts`, `src/models.ts`, `src/transcription.ts` | Reviewed | Backend/model resolution and acquisition | Process, path, network, translation, and result semantics inspected. |
| `src/streaming.ts` | Reviewed | Streaming dictation | Frame parsing, state transitions, timers, preview, diagnostics, and delivery inspected. |
| `src/settings.ts`, `src/config.ts` | Reviewed | Configuration UI and persistence | Runtime defaults, async discovery, writes, environment precedence, and UI state inspected. |
| `src/editor.ts`, `src/transcript-delivery.ts` | Reviewed | Editor fallback and transcript delivery | Pi editor composition and idle/busy delivery inspected. |
| `src/processes.ts`, `src/terminal-text.ts` | Shared infrastructure | All process/output slices | Spawn/stop/timeout/output bounds, shell hooks, cleanup, and sanitization inspected. |
| `src/constants.ts`, `src/types.ts` | Shared infrastructure | All slices | Defaults and state representations compared with callers, schema, docs, and tests. |
| `scripts/doctor.mjs` | Reviewed | Doctor diagnostics | Public `bin` entry point. |
| `scripts/check-format.mjs`, `scripts/check-package-contents.mjs`, `scripts/publish-npm.mjs` | Reviewed | Package and release validation | Publish execution was not run. |
| `dependency_check.sh`, `trivy_scan.sh` | Reviewed operational tooling | Dependency/security checks | Scripts mutate caches/reports and may use network/Docker, so execution was deferred. |
| `dev-shims/pi-coding-agent/**` | N/A (development-only shim) | Pi contract/testing review | Inspected because CI typechecks against it instead of the real peer package. |
| `test/*.test.mjs` | N/A (test source) | All applicable slices | All 12 test files inspected; none imports `src/extension.ts`. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `micme.schema.json`, `micme.example.json`, relevant docs and CI workflows | Reviewed configuration/contracts | Project map and cross-slice checks | Public defaults, package contents, scripts, and CI behavior compared with runtime. |
| `img/**`, `lcov.info`, `.trivycache/**`, `trivy-reports/**`, local `.pi/**`/`agent/**` state | Generated/Vendored or local state | N/A | Excluded except for confirming package/ignore boundaries; no local secret-bearing state was opened. |

## Cross-slice checks

| Concern | Status | Evidence or blocker |
| --- | --- | --- |
| Public Pi registration and lifecycle | Reviewed | Default export, command/shortcut registrations, editor wrapper, session hooks, local Pi docs, and installed Pi 0.80.7 types/runtime were inspected; REV-001 and REV-007 result. |
| Contract and runtime validation consistency | Reviewed | Runtime getters, settings, JSON schema, example, README, and doctor were compared; REV-003, REV-006, and REV-008 result. |
| Filesystem, subprocess, and cleanup semantics | Reviewed | Generated recording/model/config paths, shell escape hatches, output caps, process stop escalation, and cleanup paths were traced; REV-001, REV-002, and REV-004 result. |
| Network and long-running work | Reviewed | The fixed Hugging Face model URL, streamed temp-file write, response handling, shared download map, and UI/lifecycle ownership were inspected; REV-005 results. |
| Shared state and concurrency | Reviewed | Module recording state, timers, model-download map, config writes, repeated shortcuts, and shutdown ordering were traced; REV-001 and REV-004 result. |
| Error/result consistency | Reviewed | Clip, stream, device, config, model, and doctor failure paths were compared; late process exits and missing validation evidence are not preserved consistently. |
| Architecture and duplicated policy | Reviewed | Backend/model/default logic variants were searched across runtime, settings, schema, README, example config, and doctor; REV-003 and REV-006 result. |
| Type safety and Pi compatibility | Reviewed | Normal shim-backed typecheck and a targeted typecheck against installed Pi 0.80.7 both passed; CI still lacks a real-peer contract check (REV-007). |
| Security and secret handling | Reviewed | Trusted shell hooks are documented, subprocess output is capped/sanitized, package contents are guarded, and command values are redacted; no separate actionable security finding met the evidence gate. |
| Material performance | Reviewed | Captured output and stream buffers are bounded; model scans are depth-bounded. Real large-model transfer behavior remains deferred. |
| Dependencies and CI | Reviewed | `npm audit --omit=dev` reported zero vulnerabilities; CI/package/release scripts were inspected. Docker/Trivy scans were not run. |

## Commands and results

| Command | Result | Relevant evidence or blocker |
| --- | --- | --- |
| `npm run typecheck` | Passed | TypeScript completed with no diagnostics against the development shim. |
| `npm run lint:eslint` | Passed | ESLint completed with no diagnostics. |
| `npm run check` | Passed | All four shipped `.mjs` scripts passed Node syntax checks. |
| `npm run format:check` | Passed | 45 files passed the repository formatting check. |
| `npm test` | Passed | 84 tests passed; 0 failed/skipped. |
| `npm run check:pack` | Passed | Dry-run package contained 32 files and no forbidden package contents. |
| `npm audit --omit=dev` | Passed | Reported 0 vulnerabilities. |
| `npm run typecheck -- --project <temporary real-Pi config>` | Passed | All `src/**/*.ts` typechecked against installed `@earendil-works/pi-coding-agent` 0.80.7 and its matching TUI package. |
| Targeted delayed-download/overlapping-shortcut harness | Failed (finding reproduced) | Two streaming processes spawned; after `session_shutdown`, one remained alive: `{ "spawned": 2, "aliveAfterShutdown": 1 }`. The harness used a harmless fake executable and cleaned all temporary processes/files. |
| Targeted late-recorder-exit harness | Failed (finding reproduced) | A recorder exited with code 7 after writing 600 bytes; `stopRecorder()` resolved successfully. |
| Targeted numeric-config harness | Failed (finding reproduced) | Positive `0.1` values produced zero step, flush delay, word count, record rate, and transcribe rate. |
| Targeted concurrent-config harness | Failed (finding reproduced) | Two disjoint `writeMicmeConfigValues()` calls left only one key in the final JSON file. |
| Targeted runtime/doctor model fixture | Failed (finding reproduced) | Runtime selected sibling `ggml-large-v3.bin`; doctor reported configured `ggml-large-v3-turbo.bin`. |
| Targeted silence-validation fixture | Failed (finding reproduced) | A zero-exit `ffmpeg` fixture with no volume metrics returned `{ "raw": "" }` instead of an explicit validation failure/skip. |
| Build | Not available | No build script exists; Pi loads the TypeScript entry point through jiti and `tsconfig.json` is no-emit. |
| `npm run validate` | Not run | Its constituent broad checks were run individually once; rerunning it would duplicate lint/typecheck/check/test/pack work. |
| `dependency_check.sh`, `trivy_scan.sh` | Blocked | They pull/update external data and write caches/reports; existing generated reports were not treated as current-target evidence. |
| `npm run publish:npm` and publish workflow | Blocked | Publishing mutates version/commit/tag state, needs credentials/network, and is outside safe review validation. |

## Findings summary

| Severity | Count | Categories |
| --- | ---: | --- |
| Critical | 0 | — |
| High | 1 | Lifecycle |
| Medium | 5 | Correctness (2), Validation (1), Async/State (1), Lifecycle (1) |
| Low | 2 | Testing (1), Validation (1) |

## Tasks

- [x] **REV-001 · High · Lifecycle — Serialize recording operations and shut down every owned process**

  **Slice:** Pi registration/lifecycle, clip recording, and streaming startup.

  **Evidence:** `src/extension.ts:51-66`, `src/extension.ts:127-141`, `src/extension.ts:171-188`, and `src/extension.ts:215-280` use one optional `recording` reference as the entire state model. Streaming waits for `ensureWhisperCppModel()` before publishing any active state, while stopping clears `recording` before transcription completes. Pi's installed interactive runtime dispatches extension shortcuts without blocking further input. A controlled delayed-download harness invoked the shortcut twice 1.1 seconds apart and observed two spawned stream processes; shutdown stopped only the last reference, leaving one alive.

  **Violated contract or scenario:** At most one microphone operation may exist per session, and `session_shutdown` must stop all session-scoped resources. Repeated shortcuts during startup can pass the repeat guard, enter while `recording` is still undefined, and create multiple recorders. Clearing the only state reference before stop/transcription also allows a new operation to overlap old cleanup and stale UI updates.

  #### Why

  With a real `whisper-stream` executable, the orphan is an untracked microphone process that can continue capturing after Micme reports shutdown. Overlapping stop/transcribe/start work can also clear or overwrite another operation's status, widget, transcript, and cleanup decisions. Pi documents `session_shutdown` as the teardown boundary for session-scoped resources.

  #### How to resolve

  - Replace the optional-recording gate with an explicit session-owned operation state covering at least idle, starting/downloading, recording/streaming, stopping, transcribing/finalizing, and shutting down.
  - Serialize or reject every command, terminal shortcut, and printable-shortcut transition through the same owner; set the non-idle state before the first asynchronous boundary.
  - Track every spawned main and optional clip process independently until it exits, and make shutdown mark the owner closed before cancelling work and awaiting cleanup.
  - After every awaited startup step, verify that the initiating operation/session is still current before spawning, mutating UI, or publishing a transcript.

  #### Acceptance criteria

  - Concurrent command/shortcut starts can spawn at most one recorder, including when model acquisition is delayed beyond the repeat guard.
  - A toggle during stop/transcription follows one documented policy (for example, warning/rejection or serialized queueing) and cannot start unowned work.
  - `session_shutdown` during starting, recording, streaming, stopping, transcription, and finalization leaves zero child processes/timers and performs no later stale-context UI or message action.
  - Integration tests invoke the registered command, terminal shortcut, and printable fallback with deferred promises and assert valid state transitions, one process owner, and zero live processes after shutdown/reload/session replacement.
  - `npm run typecheck`, `npm run lint:eslint`, and `npm test` pass.

- [x] **REV-002 · Medium · Correctness — Preserve recorder and stream exit failures after startup**

  **Slice:** Clip recorder, live stream process, and optional stream final-clip recorder.

  **Evidence:** `src/processes.ts:63-105` awaits but discards `ExitResult`; `stopRecorder()` checks only audio-file size. `src/extension.ts:190-195` and `src/extension.ts:326-335` inspect exits only during the 700 ms startup grace, while later clip/stream stop paths do not validate spontaneous exits. A targeted recorder that wrote 600 bytes and exited with code 7 produced `{ "exit": { "code": 7 }, "outcome": "resolved" }` from `stopRecorder()`.

  **Violated contract or scenario:** A dependency failure after startup must not be represented as a successful recording merely because a partial audio file exists. A stream that has already failed must not stop as an empty/successful dictation.

  #### Why

  Microphone disconnects, backend crashes, and permission/device failures can happen after startup. Micme can currently transcribe a truncated clip or silently finish an empty stream, hiding the root cause and producing incomplete or misleading user input.

  #### How to resolve

  - Return/preserve `ExitResult` from process shutdown and distinguish a user-requested stop from a process that settled spontaneously.
  - Define expected exit codes/signals for ffmpeg and whisper-stream stop methods; surface unexpected `error`, signal, or nonzero code with capped, sanitized stderr.
  - Apply the same policy to the clip recorder, stream process, and optional final-clip recorder without treating Micme's own escalation signals as spontaneous failures.

  #### Acceptance criteria

  - A recorder that exits nonzero after the startup grace is reported as failed even when its file exceeds `MIN_AUDIO_BYTES`; no transcript is delivered from that partial file unless an explicit recovery policy says so.
  - A stream that exits unexpectedly after startup produces an actionable error rather than an empty apparent success.
  - Expected user-requested ffmpeg/stream stop paths remain successful, including escalation when graceful stop input is unavailable.
  - Focused tests cover nonzero exit, spawn error, signal exit, partial usable-size audio, normal stop input, and optional final-clip variants.
  - `npm run typecheck`, `npm run lint:eslint`, and `npm test` pass.

- [x] **REV-003 · Medium · Validation — Make one authoritative, bounded runtime configuration contract**

  **Slice:** Global config loading, runtime getters, settings UI, schema/example/docs, and command startup.

  **Evidence:** `src/config.ts:54-71` records malformed JSON as `error`, but `src/extension.ts:56-57`, `src/extension.ts:122-125`, and `src/extension.ts:171-173` ignore that state and continue with defaults; only `/micme conf` warns. `src/config.ts:267-344` validates positive numbers before rounding, so a targeted `0.1` fixture returned zero for stream step/flush/word count and record/transcribe sample rates, which are then passed to timers and external CLIs. `micme.schema.json:46-48` inherits `stringFlag`'s default `"0"` for auto-download while runtime/settings/docs default it on, and `MICME_RECORD_SYNC` collects conflicting referenced/default annotations.

  **Violated contract or scenario:** External config must be validated before microphone/network/process side effects, and normalized values must still satisfy their sink invariants. Schema, UI, runtime, example, and docs must advertise compatible defaults.

  #### Why

  Malformed JSON silently discards all intended settings and can start Micme with a different device/backend/download policy. Fractional positive inputs pass validation but become invalid zero CLI arguments or immediate timers. Schema consumers are also told that model auto-download defaults off even though missing runtime config enables it.

  #### How to resolve

  - Define reusable parsers/specifications for flags, modes, bounded integer durations/counts/sample rates, and defaults; validate the normalized value, not only the pre-rounded number.
  - Establish an explicit malformed-config policy that surfaces a sanitized warning/error before operational side effects instead of silently treating the file as empty.
  - Align the affected schema defaults and constraints with runtime constants/settings/docs; remove a shared `$defs` default when individual flags have different defaults.
  - Add contract tests that exercise both shell values and JSON values through the same runtime getters and compare declared defaults with runtime behavior.

  #### Acceptance criteria

  - `0.1`, zero, negative, non-finite, and excessively large values cannot reach timer/CLI sinks as zero, overflowed, or otherwise out-of-range values; each field applies a documented fallback or actionable error.
  - Malformed/non-object `micme.json` is reported before recording, model download, or transcription begins, with a tested and documented fallback/refusal policy.
  - `MICME_AUTO_DOWNLOAD_MODEL`, `MICME_RECORD_SYNC`, and the affected numeric fields have non-conflicting schema/runtime/UI/example defaults and appropriate schema bounds.
  - Tests cover boundary values immediately below/at/above each accepted range and verify generated recorder, transcriber, and stream arguments.
  - `npm run typecheck`, `npm run lint:eslint`, `npm run format:check`, and `npm test` pass.

- [x] **REV-004 · Medium · Async/State — Prevent lost updates to the global Micme config**

  **Slice:** `/micme conf` persistence shared across screens and Pi processes.

  **Evidence:** `src/config.ts:78-105` performs an unlocked read-modify-write: each caller reads the complete object before the first `await`, writes a private temp file, and renames it over the global path. A targeted `Promise.all()` of disjoint updates produced a final file containing only `MICME_REVIEW_B`; `MICME_REVIEW_A` was silently lost. `src/settings.ts:711-729` serializes one screen instance only and cannot protect other screens/processes.

  **Violated contract or scenario:** Successful disjoint saves to a machine-global settings file must preserve both updates, including when two Pi sessions save concurrently.

  #### Why

  Micme intentionally shares one config across projects. Two open Pi sessions can overwrite each other's recent settings while both report success, potentially changing backend, microphone, command-hook, or retention behavior without warning.

  #### How to resolve

  - Serialize in-process writes and use a cross-process lock or conflict-aware compare/retry protocol around the complete read-modify-write window.
  - Re-read the latest file while holding the write authority, merge only the requested keys, preserve non-Micme metadata, and keep atomic replacement plus `0600` file behavior.
  - Define lock timeout/stale-lock/error behavior without deleting another writer's valid file.

  #### Acceptance criteria

  - Concurrent disjoint writes from promises and separate child processes preserve both keys and existing `$schema`/non-Micme metadata.
  - Conflicting writes to the same key have a documented deterministic policy and never produce malformed JSON.
  - Failure, timeout, and cancellation remove only the caller's temporary artifacts and leave the last valid config readable.
  - Focused concurrency tests run repeatedly without lost updates; `npm run typecheck`, `npm run lint:eslint`, and `npm test` pass.

- [x] **REV-005 · Medium · Lifecycle — Make model downloads bounded, cancellable, and caller-owned**

  **Slice:** First-use streaming/clip model acquisition and model selection in `/micme conf`.

  **Evidence:** `src/models.ts:257-350` stores shared promises but accepts no `AbortSignal` or timeout; `fetch(url)` and each `reader.read()` can keep the caller pending indefinitely. `src/extension.ts:264-267` awaits acquisition before establishing recording state, and `src/settings.ts:711-729`/`src/settings.ts:1195-1204` let a save promise continue after the configuration component closes. Tests cover success and stream failure but no hanging response, caller cancellation, shutdown, or closed-screen behavior.

  **Violated contract or scenario:** Closing the initiating UI or shutting down the session must cancel/settle its long-running work, remove temporary files/status, and prevent later stale UI updates. Network waits need an explicit bounded policy.

  #### Why

  A stalled model response can hold startup or a settings save indefinitely. The operation can outlive the screen/session that owns its `ctx`, widening the concurrent-start race and allowing notifications/status mutations after the caller is gone.

  #### How to resolve

  - Thread caller-owned abort signals through `ensureWhisperCppModel`, `downloadWhisperCppModel`, `downloadFile`, `fetch`, stream reads, and status updates.
  - Add an explicit total or inactivity timeout suitable for large model transfers and distinguish timeout/cancellation from HTTP/filesystem failure.
  - Define shared-download ownership so one cancelled waiter does not corrupt another active waiter, while a download with no remaining owner is aborted and cleaned up.
  - Have the recording lifecycle and configuration screen abort their work on shutdown/close and suppress stale UI actions.

  #### Acceptance criteria

  - A never-resolving fetch and a stalled response body settle as timeout/cancellation within the configured bound, leave no target/temp file, and clear status exactly once.
  - Closing `/micme conf` or emitting `session_shutdown` during acquisition causes no later render, notification, process spawn, or config save from that caller.
  - Concurrent waiters have deterministic tested cancellation semantics and still produce one valid atomic target when at least one owner remains.
  - Existing success, HTTP error, stream error, and concurrent-target behavior remain covered; `npm run typecheck`, `npm run lint:eslint`, and `npm test` pass.

- [x] **REV-006 · Medium · Correctness — Use the runtime model resolver in doctor diagnostics**

  **Slice:** `micme-doctor` backend/model diagnostics.

  **Evidence:** Runtime `src/models.ts:124-171` remaps an explicit `ggml-large-v3-turbo.bin` to sibling `ggml-large-v3.bin` when translation is enabled. `scripts/doctor.mjs:179-205` returns every explicit path unchanged and its later warning logic checks only `.en` models. A targeted fixture reported runtime `ggml-large-v3.bin` while doctor printed `ggml-large-v3-turbo.bin` as the effective model.

  **Violated contract or scenario:** The doctor promises to report the effective model, so the same configuration must resolve to the same path/model/warnings as the extension runtime.

  #### Why

  A user can verify or download the model doctor reports and still have runtime request a different sibling file. Missing fallback files and download behavior are then diagnosed against the wrong path, undermining the primary troubleshooting command.

  #### How to resolve

  - Remove or isolate the duplicated backend/model policy in `doctor.mjs`; consume a shared runtime-safe resolver or test both adapters against one contract fixture set.
  - Preserve the doctor's redaction and no-Pi-session execution requirements while matching explicit/default model, translation fallback, backend, and existence semantics.
  - Search the duplicated config expansion/backend warning branches for additional observable runtime/doctor drift while making this correction.

  #### Acceptance criteria

  - Doctor and runtime report the same effective model path/name/source for default, configured-name, explicit `.en`, explicit turbo, missing, and translation-off/on fixtures.
  - Doctor warns about the actual fallback file when it is missing and does not claim the configured turbo file is effective.
  - Automated doctor tests execute the public bin path with isolated temporary config/PATH fixtures and assert command values remain redacted.
  - `npm run check`, `npm run lint:eslint`, `npm run format:check`, and `npm test` pass.

- [x] **REV-007 · Low · Testing — Validate CI against the real supported Pi contract**

  **Slice:** Pi API integration and release validation.

  **Evidence:** `package.json:79-84` declares real Pi/TUI peers as `*` but resolves the coding-agent dev dependency to `dev-shims/pi-coding-agent`. That handwritten shim uses broad `string` event/shortcut/mode types and omits real APIs (`dev-shims/pi-coding-agent/index.d.ts:50-94`). CI runs only this shim-backed typecheck, and no `test/*.test.mjs` file imports `src/extension.ts`. A targeted compile against installed Pi 0.80.7 passed, so this is a CI coverage gap rather than a claimed current incompatibility.

  **Violated contract or scenario:** Published extension registration and lifecycle code must be checked against the real supported Pi API; a permissive local approximation cannot detect future event, context, editor, renderer, or key-contract drift.

  #### Why

  The most consequential verified defect is in untested registration/lifecycle orchestration. The current shim can continue compiling after the actual peer API changes, while wildcard peer ranges claim compatibility without a release gate that proves it.

  #### How to resolve

  - Add a CI job/typecheck using a pinned supported real `@earendil-works/pi-coding-agent` and matching `pi-tui`, or generate/verify the shim from those declarations.
  - Define the supported peer range or compatibility policy and update it intentionally with dependency automation.
  - Add a jiti-based extension load/registration smoke test using a faithful Pi harness; keep detailed state regression tests with the owning findings rather than duplicating them here.

  #### Acceptance criteria

  - CI typechecks all production TypeScript and loads the default extension against at least the minimum/current supported real Pi contract with matching TUI types.
  - A deliberate invalid event name, shortcut type, context/UI call, or editor contract change fails the real-contract gate.
  - The development shim is removed, generated, or automatically compared so it cannot silently diverge.
  - Package peer ranges and the tested compatibility versions are documented; normal lint/typecheck/test/package checks pass.

- [x] **REV-008 · Low · Validation — Do not treat missing silence metrics as successful validation**

  **Slice:** Clip audio validation before transcription.

  **Evidence:** `src/audio.ts:660-687` treats any zero-exit `ffmpeg` run as validated even when `parseVolumeDb(..., "max_volume")` returns `undefined`; the threshold guard runs only when the metric exists. A zero-exit fixture with empty output returned `{ "raw": "" }`. README and the settings screen describe `MICME_VALIDATE_AUDIO=1` as rejecting near-silent recordings.

  **Violated contract or scenario:** When silence validation is enabled and its required metric cannot be parsed, Micme must not silently represent the validation as successful.

  #### Why

  An unexpected ffmpeg output format, truncated output, or adapter regression disables the hallucination guard without telling the user, allowing the exact near-silence behavior the setting claims to prevent.

  #### How to resolve

  - Make the validation outcome explicit: validated with metrics, intentionally skipped because ffmpeg/validation is disabled, or failed because required evidence is unavailable.
  - For a zero-exit run without `max_volume`, fail with capped sanitized diagnostics or issue a clear warning under a documented fail-open policy; do not return an indistinguishable successful diagnostics object.
  - Keep missing-ffmpeg behavior explicit and consistent with the chosen policy.

  #### Acceptance criteria

  - Empty, malformed, partial, and oversized/truncated zero-exit ffmpeg output cannot silently pass as successful silence validation.
  - Tests distinguish disabled, missing dependency, valid audible, valid `-inf`/silent, nonzero exit, and missing-metric outcomes and verify the caller's user-facing behavior.
  - Error/warning text remains sanitized and bounded; `npm run typecheck`, `npm run lint:eslint`, and `npm test` pass.

## Blocked or deferred coverage

- **Live Pi lifecycle replacement and actual microphone capture:** Not run because it would access hardware and start real audio processes. Source review used Pi's complete local extension documentation, installed runtime dispatch code, and a harmless controlled process harness. Revalidate REV-001 in a disposable live Pi session on shutdown, `/reload`, `/new`, `/resume`, and `/fork`.
- **Native platform integrations:** macOS was source-reviewed but no microphone command was executed; Windows/Linux behavior was limited to source and mocked fixtures. Run hardware/device/transcription smoke tests on each supported OS without retaining private audio.
- **Real Whisper backends and Hugging Face model transfer:** Not run because they require external binaries, large downloads, and potentially private audio. Use small controlled fixtures or an injectable local HTTP server for cancellation/error contract tests.
- **Docker Dependency-Check and Trivy:** Not run because the repository scripts update external databases/images and write generated caches/reports. Run them in isolated CI or an explicitly authorized clean workspace and attach only sanitized summaries.
- **Publish execution:** Not run because it requires npm credentials and mutates version, commit, tag, registry, and remote state. Validate in the protected release workflow.
- **Local ignored state:** `.env`, `.pi/**`, `agent/**`, caches, recordings, and existing security reports were intentionally not opened as review evidence to avoid exposing secrets or stale generated data.

# Handy to Micme: phased transfer roadmap

Kind: roadmap

## Purpose and scope

**First read [What Micme can learn from Handy](research-handy.md)**. It compares the released products, source, issue history, measurements and reuse rights. The numbered phases below are future build requests, not claims that the changes exist. No implementation or product release is part of this delivery.

- “resurch this app and se what can be learned from it”: starting at [Handy issues](https://github.com/cjpais/Handy/issues), the comparison gives the [research method](research-handy.md#finding-and-evidence-boundary), feature inventory and [requested vs shipped distinctions](research-handy.md#what-the-issue-tracker-does-not-establish).
- “copied over to misme so that it is preform like this application”; “all the features and benefits from the app transfered to mine”: P1 defines how to substantiate performance. P2–P8 transfer capture, models, language, recovery, files and optional processing; P9–P12 cover desktop-only journeys. Each inventory row says what to keep, adapt or deliver separately, and how to check it. Brand copying, unsupported model promises and unshipped requests are out of scope.
- “detailed resourch first and plan creation”: the comparison stands on its own. Use [Request for each phase](#request-for-each-phase) to commission later work, one phase or qualified model/platform cohort at a time.

A separate companion is needed because Pi’s API does not provide global key-up events, a tray, OS permission controls or focused-app insertion. A comparison harness is needed because matched performance measurements are missing. Neither becomes a dependency of ordinary Pi dictation.

Local ASR, fixtures and development need no outside account. Hosted polish requires access to the provider only when explicitly enabled. Signed production distribution needs the appropriate platform signing/publishing access; an unavailable signer blocks that channel, not the local build.

## Goal

“Perform like this application” has two endpoints. **Inside Pi**, dictate, see useful feedback, review correct text, and recover a failed take without damaging the prompt. **Outside Pi**, explicitly start a Micme-branded companion, activate from another app, speak, see non-focusing feedback, and get the final text once in the intended receiving field. Neither journey requires a cloud account, persistent history, or LLM rewriting.

Call a benefit transferred only when its check in the [comparison](research-handy.md#capture-readiness-and-feedback) passes. Publish a scorecard by product revision, feature, model, language, OS/arch/display, device, target, and cold/warm state: **existing and verified**, **adapted and verified**, **desktop-only and verified**, **blocked** (reason), or **unverified**. Separate functional coverage from measured parity: complete local dictation is not proof of equally fast insertion. Keep issue-only ideas and post-tag changes out of the stable denominator.

## State today

| What exists | File |
| --- | --- |
| Handy v0.10.2 desktop: global trigger, capture → model-dependent streamed/long-form/batch ASR → optional polish/history/hook → focused-app delivery. Desktop imports are separate from headless batch. | [Stable source and distinctions](research-handy.md#finding-and-evidence-boundary), [models](research-handy.md#models-setup-and-inference), [desktop](research-handy.md#desktop-activation-display-and-delivery). |
| Micme v0.4.1: Pi toggle, default post-stop clip or experimental SDL stream; main has the same manifest version but replaces SDL. OMP 19.2 fix on open PR only. | [Release/main/PR ledger](research-handy.md#the-micme-a-user-can-install-and-the-one-on-main); [tagged README](https://github.com/senad-d/micme/blob/v0.4.1/README.md#live-dictation). |
| Main: ASR + VAD ready before opening one verified WAV; provisional widget vs committed Pi text, explicit RPC replay, optional verified refinement. For English with no override, whisper.cpp clip defaults to `small.en`; live and Python clip both default to `base.en` ([model defaults](../../../src/constants.ts)). | [Live plan](../../../src/live-plan.ts), [extension lifecycle](../../../src/extension.ts), [live presentation](../../../src/streaming.ts), [editor delivery](../../../src/transcript-delivery.ts), [README](../../../README.md#live-dictation). |
| Existing device/settings picker, manual and downloadable models, shell hooks, session replay, optional audio retention, standalone doctor. No library, desktop process, target clipboard, GUI import or cloud rewrite in these paths. | [Settings](../../../src/settings.ts), [models](../../../src/models.ts), [trust/retention](../../../SECURITY.md), [entry points and package files](../../../package.json). |
| Main worker source builds separately; normal validation does not exercise a hardware voice matrix. Paced Linux results separate relevant first words, sustained drafts and final WER. No matched Handy–Micme comparison. | [Worker](../../../native/live/README.md), [tests and gates](../../../test/live-native/README.md#interpreting-the-report), [recorded results](../../../test/live-native/results.md), [measurement interpretation](research-handy.md#what-the-measurements-actually-compare). |

## Phases

| No. | Horizon | Name | What the user has when it is done | Needs from earlier phases | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | now | Comparable dictation baseline | Reproducible results showing where time, words or delivery are lost, or why a cell is not comparable. | None | 3–5 days |
| 2 | now | Trustworthy capture in Pi | Sample-observable inputs report readiness; opaque clip hooks remain stoppable and their completed audio is checked after stop. | 1 | 3–5 days |
| 3 | next | First successful take and trustworthy models | Guided setup, discoverable capability/rights matrix, verified installs and offline reuse. | 1 | 4–7 days |
| 4 | next | Recognition by capability | More runnable local models; useful preview or appropriate batch/long-form behavior, bounded recovery and resource controls. | 2, 3 | 5–10 days for first model pair; repeat by family |
| 5 | next | Language and local text fidelity | Explicit language/translation, optional dictionary, fillers and script handling with original preserved. | 3, 4 | 3–6 days |
| 6 | next | Recover a take across restarts | Opt-in local audio/text history, playback, retry and predictable deletion. | 2 | 4–7 days |
| 7 | next | Transcribe existing files | Cancellable media jobs in the library and independent local PCM-WAV CLI. | 4, 6 | 4–7 days |
| 8 | next | Optional polishing and output hooks | Explicit local or user-selected remote text transformation, with a trustworthy original. | 5, 6 | 3–6 days for first adapters; repeat by provider |
| 9 | next | One desktop dictation journey | Separate local companion on Linux X11: a global toggle, visible state and one final insertion into a real field. | 2, 3 | 4–7 days |
| 10 | later | Desktop activation, audio and feedback | Permission-aware setup, hands-free/hold modes, sound, overlays and notices tailored to each desktop. | 4, 9 | 4–8 days per platform family |
| 11 | later | Reliable focused-app delivery | Qualified paste, direct typing, copy-only/history-only, explicit recovery and privacy distinctions. | 6, 9 for X11 and isolated adapter checks; also 10’s native activation slice for end-to-end qualification on each other desktop | 4–8 days per display/OS family |
| 12 | later | Operate and distribute the companion | Library/import UI, tray/settings/automation, localized accessible controls, portable or managed installs and independently qualified releases. | 5, 7, 8, 10, 11 | 5–10 days for first qualified channel; repeat by channel |

Sizes are rough effort ranges for scoping a later request, not commitments or evidence of parity. Each phase produces a usable result on a declared configuration. Model, provider and platform cohorts repeat the relevant phase until every reference entry has passed or has an explicit blocker; one example is not a claim for its family.

## Phase detail

### Phase 1: Comparable dictation baseline

- Outcomes: Extend the public-fixture workflow in [test/live-native](../../../test/live-native/README.md), without changing existing scores. Pin Handy stable, tagged Micme and Micme main separately. Produce a run manifest, paired per-take stage timings, expected vs observed target text, denominators including failed takes, and a table of passing/failing/unavailable cells. Start with local CPU, English manual language, no polish, same reference audio and isolated target. Distinguish exact-weight PCM comparisons from matched user journeys using the nearest supported exports. Add short/onset, quiet, negative, sustained, pause/repeat and multilingual controls as specified in the [parity protocol](research-handy.md#how-to-substantiate-parity).
- Kinds of plan: `testing`, `hardening`. Exit: one documented local replay yields separate first samples, first useful visible words, final ASR, target mutation, WER and error counts; timed cells meet the protocol's minimum repeats or are explicitly exploratory. Reproduce the Pi interaction without sending a prompt. Qualify physical-mic, GPU, macOS and Windows cells only where evidence is available.
- Left for later: Faster inference, tuning defaults, product features and any cross-platform speed headline. Missing hardware is an evidence gap, not a reason to invent numbers.

### Phase 2: Trustworthy capture in Pi

- Outcomes: Carry [C1–C4](research-handy.md#capture-readiness-and-feedback) into `src/audio.ts`, `src/extension.ts`, `src/live-capture.ts`, widget and doctor. Gate a ready cue on observed samples for built-in clip and live paths that expose trusted PCM. Distinguish model preparation, waiting for samples, digital zero, no speech, processing and delivery failures. Report actual device/channel only when known; distinguish requested input from confirmed input and disclose fallback. If a custom clip hook exposes no samples before stop, show “recorder running; stop to finish,” not “mic ready.” Keep normal stop available without a WAV, leave first-sample timing/device/channel unknown, and apply existing clip checks to the completed output after stop. No new hook protocol or sound requirement.
- Kinds of plan: `feature`, `interface`, `hardening`. Exit: delay the first built-in/live samples: no premature ready cue, no late output after cancel, onset and tail preserved, usable next take after unplug. Run the [close-only clip fixture](../../../test/extension-lifecycle.test.mjs#L2290-L2334): no invented sample or device indication; a normal user toggle stops the hook, its SIGINT handler writes the WAV, the valid take yields one review paste and no send, and the next take starts and stops normally. Verified PCM coverage/identity and Pi draft/edit/RPC gates still pass. Compare with P1; optimize only the demonstrated stage.
- Left for later: Warm microphone, speaker muting, global shortcuts and native permission prompts. Do not replace the single verified spool with a second recording to hide a timing problem.

### Phase 3: First successful take and trustworthy models

- Outcomes: Adapt [M1–M3](research-handy.md#models-setup-and-inference) and L2 to `src/settings.ts`, `src/models.ts`, `src/live-plan.ts` and doctor. A fresh Pi user can check prerequisites, pick language/model/device, reuse installed weights or authorize the configured download and try a local sample. Show explicit model capabilities, measured speed/error with rig or unknown, and progress/cancel/remove. Maintain a row for **each** reference ASR entry; model rights, loadability and measured capability are independent statuses. Begin verified downloads with already supported ASR; local custom paths remain trusted overrides.
- Kinds of plan: `feature`, `interface`, `hardening`. Exit: clean and offline installs produce a reviewable take or a specific repair action. Pinned revision, size and digest gate publication; corrupt cache, interrupted transfer and proxy without Range cannot yield a “ready” model. Migration preserves user data and distinguishes unsupported SDL settings from a broken microphone.
- Left for later: New engines/weights until the [reuse gates](research-handy.md#reuse-and-license-gates) and runtime trials pass; no blanket reuse of Handy’s catalog labels, mirror, sounds or grades.

### Phase 4: Recognition by capability

- Outcomes: Use [M4–M6](research-handy.md#models-setup-and-inference), C3 and A4: one approved native streamer and one batch model beside existing whisper.cpp. Record effective traits after load (stream, native long-form, batch, language/translate, VAD and actual compute device). Route to preview, pause-aware chunks or whole take accordingly. Model/process reuse and idle unload are independent of keeping the mic open. Isolate crashes/returned errors, offer visible same-take recovery; do not silently override explicit device/backend or replay a cancellation. Qualify optional VAD/detector/device choices by measurement.
- Kinds of plan: `feature`, `hardening`. Exit per artifact: recorded offline load, task/language positives and negatives, sustained useful preview **if supported**, silence/pauses/seams/long-input memory, raw final and exact target once; restart/recover after worker failure, reset VAD/context on new take. Publish P1 cold/warm/unload results and actual device. Repeat by model family/quant for all cleared reference entries, not just the first pair.
- Left for later: Blocked artifact/device cells remain listed with reason and evidence needed. No stealth rewrite of existing Whisper live behavior, CPU/GPU ranking from metadata, or new HTTP service.

### Phase 5: Language and local text fidelity

- Outcomes: [L1–L3](research-handy.md#language-vocabulary-and-final-text). Add compatible preference lists, manual/native auto/local external LID as applicable and **distinct** translate-to-English. Separately opt into vocabulary, native bias or conservative local correction, filler/echo rules and Chinese script conversion. Show when rules did not apply. Keep raw recognized text separate from transformed output so accuracy and recovery remain meaningful.
- Kinds of plan: `feature`, `interface`. Exit: fixed multilingual references separate recognition from translation; known incompatible weights rejected. Compare names and code identifiers, true repeats, ambiguous filler words and silence with controls on/off. Report benefits and losses by language.
- Left for later: Arbitrary target translation, keyboard-layout language switching and a free-form initial-prompt setting are not stable reference features.

### Phase 6: Recover a take across restarts

- Outcomes: [H1/H2](research-handy.md#recovery-imported-files-and-optional-processing). Keep session replay unchanged. When explicitly enabled, save local original/processed text, status, source/time/language and verified WAV reference; paginate, expand/copy, playback/seek, star, delete, re-transcribe with current model, cancel. A failed ASR with valid saved audio is retryable; failed delivery with valid text is copyable. Implement count/age/never, preview pruning, protect starred/imported rows; no app-encryption claim.
- Kinds of plan: `feature`, `interface`, `hardening`. Exit: survive restart and retry without dictating again; verify row **and** audio on prune/delete, disk/save error and disabled retention. Never reopen an unverified replacement or misreport an unsaved WAV as safe to retry. No new persistent history by default.
- Left for later: Import queue, desktop library GUI and optional cloud processing. An existing kept-audio directory is not silently ingested.

### Phase 7: Transcribe existing files

- Outcomes: [F1/F2](research-handy.md#recovery-imported-files-and-optional-processing). Offer local multi-file import to P6; probe/decode first audio track, normalize, identify original filename, publish only complete WAV, chunk jobs even where interactive dictation would not. Expose progress, cancellation, retry, priority at chunk boundaries and fixed model per job. Separately deliver one-off mono 16 kHz PCM16 WAV CLI, installed model/compute selection/listing, timing repeats and JSON, no library/desktop dependency.
- Kinds of plan: `feature`, `interface`. Exit: exercise mixed media including Opus, malformed/no audio, cancellation/restart and foreground dictation during a long job; no hook, paste or auto-submit. CLI rejects other formats and missing weights without downloading or creating history.
- Left for later: Desktop picker/drop (P12); not speaker-labeled meetings, subtitle export or arbitrary-codec guarantees.

### Phase 8: Optional polishing and output hooks

- Outcomes: [T1/T2](research-handy.md#recovery-imported-files-and-optional-processing). Explicitly invoked polish on a final transcript only; original kept, selection of local/provided endpoint, prompt and model. Start with local test endpoint and compatible API families, then qualify each named provider and the conditional on-device Apple path. Make destination/data/credential requirements visible. In clip and desktop final-only delivery, history sees raw and optionally polished text before the trusted hook; its nonempty result replaces the pending output once. Empty hook output or cancellation suppresses that pending insertion and any send, not words already in an editor.

  For live takes, keep [Pi commit and delivery](../../../src/streaming.ts#L269-L326) unchanged. Never run this pipeline on live commits or automatically at stop. Offer processing of a saved live final only on explicit request, for review/manual copy outside the prompt. It previews a nonempty transformed result; an empty hook result or cancellation produces no candidate. None of these outcomes writes the editor, sends/queues a message or changes the ordinary saved replay. Live RPC still writes/sends nothing until explicit replay: `/micme last` replaces the prompt with auto-submit off, or sends/queues with it on.
- Kinds of plan: `feature`, `hardening`. Exit: start with an existing TUI prompt, one confirmed live commit and a subsequent user addition. Snapshot the edited prompt and the saved unprocessed final. In separate runs, transform, return empty from the hook, or cancel the explicit processing action. In all three, the prompt stays exactly as edited (no rollback or duplicate), `/micme last` still refers to the unprocessed final and there are zero sends/queues, even with auto-submit on. Verify pending clip/desktop output is suppressed on empty/cancel. Blank/invalid/timed-out polish falls back to raw; hook timeout/error falls back to pre-hook text. Test numbers, identifiers and instruction-like speech with a local stand-in; ordinary ASR makes no provider call.
- Left for later: Desktop hotkey wiring; no cloud speech service, automatic remote polish, Windows parity claim for the Unix reference hook, or runtime requirement for hosted credentials.

### Phase 9: One desktop dictation journey

- Outcomes: Deliver one separately launched Micme companion on **Linux X11** with local CPU ASR: one global toggle, one real capture via the qualified Micme path, non-focusing recording/working status, stop and one final insertion in a controlled GUI editor. Include a single documented local start with a known public replay/installed local fixture model, plus a real mic path. Do not require Pi login, a hosted provider or always-on mic. Share model/capture behavior through a host-neutral boundary; Pi remains an independent consumer, never a proxy for OS-wide paste.
- Kinds of plan: `product`, `interface`. Exit: Pi closed, focus another app, dictate/stop and observe exactly the expected final there; cancel gives none, failure leaves manually retrievable text. Prove no desktop listener, clipboard access or companion install is introduced on the Pi path. This is the first S1–S3 slice, not a Linux-wide support claim.
- Left for later: Full global gesture modes, key conflicts, overlays, tray/settings, portable packaging and remaining OSes; keep this slice small enough to discover target/focus limitations early.

### Phase 10: Desktop activation, audio and feedback

- Outcomes: Complete [S1/S2, S5/S6](research-handy.md#desktop-activation-display-and-delivery), [C1–C4](research-handy.md#capture-readiness-and-feedback), M1 and A2 per native desktop. Provide guided permission/model/Try It recovery, global hold/toggle/300 ms hybrid with rebind/cancel, activation timestamps/repeat handling, timed/metered non-focusing overlay with live/compact/off/top/bottom and persistent notices. Platform-appropriate keyboard backends/CLI bindings, mic/channel/fallback, optional pre-open/delayed close, feedback device/volume/custom sounds, mute/restore, clamshell/AirPods where applicable. Expose experimental controls only where qualified.
- Kinds of plan: `product`, `interface`, `hardening`. Exit: keyboard-only, pedal/repeat/cancel, permission denial and recovery, silent/stalled mic, no-model/retired model, BT changes, hidden overlay and playback restoration. Compare capture cost to indicator/idle resource use. Confirm no focus theft and no tentative text at destination; Linux starts with overlay off. Use Micme-owned sounds/visuals.
- Left for later: Final output method coverage in P11. Unsupported secure inputs, Apple keyboard features or Wayland protocols get guidance, not a privilege workaround.

### Phase 11: Reliable focused-app delivery

- Outcomes: Finish [S3–S6](research-handy.md#desktop-activation-display-and-delivery). Expose paste/restore vs retain-copy, copy-only/history-only and qualified direct typing/external paste method; trailing-space and submit chords explicitly selected. Qualify macOS Cmd+V and Windows Ctrl+V, optional receipt-aware restore; Linux Shift+Insert with PRIMARY and clipboard, native/fallback tool routes across X11/GNOME/KDE Wayland. Handle privilege, focus and keyboard-layout limitations without working around OS protections.
- Kinds of plan: `feature`, `interface`, `hardening`. Exit: measure from the real stop activation to one complete final in the observed GUI or terminal field. P9 supplies that event on X11 (the stop toggle, not a hold release); other desktops need their own runnable P10 activation path. An isolated paste-adapter test is not this measurement. Test stale clipboard sentinel, delayed read, competing clipboard manager, Unicode/non-US layout, lost focus, prior text/image and missing tool/permission. Keep result available and distinguish unconfirmed delivery from success; don’t claim clipboard restoration prevents managers seeing text.
- Left for later: Only report native OS/display/target combinations actually qualified. No API-independent promise to observe insertion in arbitrary apps; use an instrumented receiver for the comparison.

### Phase 12: Operate and distribute the companion

- Outcomes: Complete [A1–A5](research-handy.md#application-controls-integrations-and-distribution), H1, F1, T1 and S1. Tray/status/settings, advanced/debug gates, local library and file picker/drop, language/model and copy-last controls, polish shortcut, theme/locale/accessibility, notices/release notes/support/logs. Add opt-in login start, hidden/no-tray precedence, running-instance CLI and OS-appropriate signals; document external launcher equivalents (optional Raycast adapter only if separately permitted). Portable data/cache and signed updates only on supported channels. Package and qualify each OS/arch/backend separately, without altering Pi’s install behavior.
- Kinds of plan: `product`, `interface`, `infrastructure`, `release`. Exit per channel: install → permissions/weights → real dictation to another app → import/play/retry/delete → quit → upgrade/uninstall. Test IME/keyboard/screen reader, locale fallback, portable paths, update disabled/invalid signature, hidden app recovery, no credentials in logs. Publish which model/platform/locale/provider cells passed, were adapted, or remain blocked, with exact dependencies/asset notices. Preserve independent npm package checks.
- Left for later: Unqualified channels, rights-unclear assets and optional third-party launcher releases stay explicitly pending. Do not add the post-tag cold-start toggle or stable tray ID as a stable parity requirement.

## Order

| Phases | Can swap or run side by side | Why |
| --- | --- | --- |
| 1 → all | No speed claims before baseline | Keep fixture/observer/gates fixed while comparing changes. An unavailable native host blocks its comparison only. |
| 2 and 3 | Parallel after 1 | Capture consumes local verified models; setup can use the existing clip/live engines. |
| 4, 6, 9 | Parallel once their listed inputs exist | Model/worker selection, local retention and a thin desktop host solve different failures. The desktop slice can use existing whisper.cpp and basic session recovery. |
| 5 and 7 | Parallel after 4 when 3/6 are ready | Language/formatting and media scheduling share the selected model’s capabilities but have different outputs. |
| 8 and desktop work | Parallel after 5/6 | Text processing is an explicit final-only operation; a desktop host can first qualify ordinary local dictation. |
| 10 and 11 | After P6/P9, X11 delivery and isolated adapter checks can proceed alongside P10. On every non-X11 desktop, wait for that desktop’s P10 activation slice before claiming end-to-end delivery. | P9 supplies a real X11 stop toggle; e.g. a macOS Cmd+V adapter can be checked in isolation, but macOS stop/release-to-insertion requires the running companion and actual native stop event from P10. P10 also supplies toggle/cancel for compositor-owned bindings; P12 reuses them. |
| 12 | Last for a complete release channel | Integrates previously exercised operations. Do not hide an unsupported model, receiver or platform behind an installer. |

Pi-first alone would miss system-wide dictation; a desktop rewrite first would postpone benefits already close to Micme and lose the measured Pi baseline. The two tracks meet at verified audio, model capabilities, cancellable final results and explicitly owned history, not at a global clipboard.

## Risks

| Risk | Phase it threatens | Trigger | What limits it |
| --- | --- | --- | --- |
| Wrong starting product | 1–4 | npm/tag, local main, cached default and open PR have different live paths despite version 0.4.1. | Record install provenance, tree/worker hash and host version; no OMP or SDL/main substitution. |
| Optimizing the wrong interval | 1–5, 9–11 | Fast engine or early draft, but late mic, stale draft, missing tail or wrong target. | Separate stage timers, paced relevance, raw accuracy and observed insertion; interleave matched runs, publish failed takes. |
| Idle resource/privacy cost | 2, 4, 10 | Reused models, warm mic, loading overlap or VAD clipping change readiness, state or retained audio. | Separate mic from model lifetime; explicit warm policy, reset between takes, indicator and idle measurements, exact PCM ledger. |
| Trust regression | 2, 6–8 | Capture moved/replaced, user edits prompt, failed ASR/blank rewrite, import or stale result auto-sent. | Verified handle and private snapshots, generation/cancel checks, originals and explicit recovery. Keep review-first Pi, write-only RPC replay, own child shutdown. |
| Local data exposure | 3, 6, 8, 11–12 | Retention edits prune or persist more than expected; staged clipboard, logs, remote polish, model/update downloads. | Show storage/exemptions and destination; separate network consents and transformations, redact logs, no promise of clipboard secrecy or “never written.” |
| Incompatible or uncleared artifact | 3–5, 8, 10, 12 | GGUF doesn't load, metadata overstates capability or a license conflicts. | Exact-artifact test and [rights ledger](research-handy.md#reuse-and-license-gates); no bulk weight download, exported brand assets or hidden fallback. |
| OS use exceeds available evidence | 9–12 | Wayland focus/tool restrictions, macOS permissions, elevated Windows targets, unsupported GPU or missing signer. | Start with one qualified receiver, use native qualification for each advertised cell, retain copyable text; defer blocked channels. No Windows runtime tests in this environment; package checks are not a substitute. |

## Request for each phase

Each quotation is a separate future build request. The comparison it names is `docs/plans/handy-transfer/research-handy.md`; its IDs identify the source evidence and acceptance checks. Revalidate the pinned baseline before changing it. No phase assumes later phases are installed.

### Phase 1: Comparable dictation baseline

> Build a reproducible local Handy–Micme comparison using [the parity protocol](research-handy.md#how-to-substantiate-parity) and Micme’s existing `test/live-native` fixtures/gates. Compare Handy v0.10.2, tagged Micme 0.4.1 and default-tree 70ad138 separately; report exact artifact and backend. Start on Linux CPU with matched public WAV and paced input, real target observation and no polish. Report cold/warm first samples, first relevant draft/progression, commit, raw final, release-to-correct insertion, WER/CER, lost/failed takes and memory, with predeclared repeats/tolerance. If a model, target, loopback or native host cannot be matched, report why and do not call parity. Deliver a local replay and per-condition results, not product tuning.

### Phase 2: Trustworthy capture in Pi

> Using P1 and [C1–C4](research-handy.md#capture-readiness-and-feedback), distinguish preparing, observed first samples, digital silence, no speech, device/inference/delivery failure and recovery. Delay built-in/live PCM: no ready cue before actual samples. Report actual device/channel only with evidence; distinguish requested input and disclose fallback. For a custom clip hook that writes its WAV only on SIGINT, show recorder running, not mic ready; do not wait for bytes to enable normal stop or invent a device/channel. Require no new hook protocol: stop by toggle, validate completed output, transcribe and paste once for review, send nothing, then complete a second take. Preserve one verified live PCM, exact drain, no mic on load and Pi edit/RPC safeguards. Compare known timings, quiet onset/tail, cancel/restart and lost-device recovery; mark unobservable timings unknown. Leave warm-mic/global controls to the companion.

### Phase 3: First successful take and trustworthy models

> Build a Pi first-use and model workflow from [M1–M3](research-handy.md#models-setup-and-inference) with P1 fixtures. Guide language/model/device selection, current SDL migration, repair and a local Try It. Create an exact-artifact disposition for the 73 reference ASR entries, including unknown measurements and explicit runtime/rights blockers. For offered standard downloads require a pinned source, size/hash, progress, cancel, safe resume/removal and offline reuse; preserve user paths and existing clip/live choices. Show success from a clean install and a populated offline cache and recover from corrupt/missing/interrupted weights; do not offer unchecked models.

### Phase 4: Recognition by capability

> Given first-sample capture and verified model setup, add local inference capability routing per [M4–M6](research-handy.md#models-setup-and-inference). Start with one legally cleared streamer and one batch artifact; preserve whisper.cpp, explicit backend choices and Worker v1 safety. Distinguish preview, pause-aware chunks, native long-form, final batch recovery and cancellation. Expose actual hardware and model unload/reuse; bound worker retries, CPU recovery only under Auto. Pass the paced relevance, final WER, pause/rollover, exact feed, no-speech and crash/next-take checks. Run the same qualification for remaining model families and eligible backends; publish unsupported/rights-blocked rows, never extrapolate one model’s result.

### Phase 5: Language and local text fidelity

> Extend the capability-tested Micme recognizers with [L1–L3](research-handy.md#language-vocabulary-and-final-text): explicit/manual/Auto language, compatible preferences and optional local LID, translation only to English on capable weights, optional words/fillers/script finishing with raw text retained. Keep locale separate and never wait for external LID to start streaming. Use multilingual human references, names/code, intentional repetitions and silence to show per-language benefit/loss, reject unsupported settings and distinguish transformation errors from ASR. Ship no cloud or context-scraping dependency.

### Phase 6: Recover a take across restarts

> Add opt-in local history to Micme per [H1/H2](research-handy.md#recovery-imported-files-and-optional-processing) using the verified capture path. Preserve session replay/default cleanup; support original and processed text, verified failed takes, playback/seek, copy/star/delete, retry with current model and cancel. Implement count/age retention, exemptions and explicit application of destructive changes. Demonstrate a restart and retry after ASR failure, copy after delivery failure, graceful save failure, and exact row/WAV deletion with protected entries surviving. No library or WAV retention by default beyond existing documented transient/failure paths.

### Phase 7: Transcribe existing files

> Given the local library and capability-tested recognizer, add [F1/F2](research-handy.md#recovery-imported-files-and-optional-processing). Import multiple local audio/video files to recoverable library jobs, normalize first audio track, chunk for progress/cancel/yield, prioritize retries and let live dictation take priority at work boundaries. Keep imports until explicit deletion. Separately provide installed-model-only standard PCM16 WAV CLI with compute/model selection/listing, repeats and JSON, no UI/history dependency. Show Opus, no-audio, corrupt media, interrupted and retried jobs; neither imports nor CLI paste or invoke the dictation hook.

### Phase 8: Optional polishing and output hooks

> Implement explicitly invoked polish and a trusted Unix output hook per [T1/T2](research-handy.md#recovery-imported-files-and-optional-processing). Support qualified local, compatible hosted and conditional Apple on-device providers, with prompt/model selection and a local test stand-in. Show what leaves the device; no audio/drafts, secrets in logs or provider calls for ordinary ASR. For clip and desktop final-only output, keep raw, fall back to it on invalid/blank/failed/timed-out polish, then run the hook after history. Deliver a nonempty hook result once; hook failure uses pre-hook text, empty stdout or cancel means no pending insert/send.
>
> Leave ordinary Pi live commits, stop and replay alone. Process a saved live final only on explicit request as a review/manual-copy preview. Test with a pre-existing TUI prompt, a confirmed live commit and a subsequent user edit: success shows the transformed candidate outside the prompt; empty hook stdout or cancellation shows no candidate. In each case the editor remains byte-for-byte as edited, `/micme last` retains the unprocessed saved final, and nothing is sent or queued, even with auto-submit enabled. Never append a second copy or undo the commit. Live RPC neither writes nor sends automatically; only explicit `/micme last` replaces the prompt (auto-submit off) or sends/queues (on). Check these separately from clip/desktop suppression.

### Phase 9: One desktop dictation journey

> Build a separately started, Micme-branded Linux X11 companion using the existing verified capture and installed model setup. Deliver one thin [S1–S3](research-handy.md#desktop-activation-display-and-delivery) journey: global toggle outside Pi → actual samples → visible non-focusing state → local final → one insertion into the focused GUI text field. Include one documented command that starts the local journey with public sample replay and a local model, then demonstrate a real device where available, cancel and recoverable delivery failure. No Pi/provider account, background listener in the extension, tentative writes to the receiver, or desktop install required for Pi.

### Phase 10: Desktop activation, audio and feedback

> Extend the running companion and capability-aware model path using [C1–C4](research-handy.md#capture-readiness-and-feedback) and [S1/S2/S5/S6](research-handy.md#desktop-activation-display-and-delivery). Build permission/setup/Try It recovery, global configurable hold/toggle/hybrid/cancel, compositor-owned toggle/cancel route, stateful tray/overlay feedback and notices. Add qualified input/channel, optional warm/clamshell/AirPods, output device, original sounds and mute/restore. Exercise repeat/pedal, denied and revoked permissions, hardware changes, first-sample cue, useful vs compact/disabled overlay, no focus theft or retained mute after cancel. Keep Pi toggle behavior unchanged and publish native platform limits.

### Phase 11: Reliable focused-app delivery

> Qualify final delivery from the desktop companion per [S3–S6](research-handy.md#desktop-activation-display-and-delivery), with opt-in recovery history. Implement supported paste chords/restore, copy-only/history-only/direct typing, optional trailing space and guarded submit, Linux custom paste/PRIMARY/tool routes, receipt-aware mode where available. Compare actual text in GUI and terminal targets under slow/competing clipboard reads, focus changes, alternate layouts and blocked permissions/elevation. After P6/P9, qualify X11 from P9’s real stop toggle to observed target contents. Isolated adapter work elsewhere (e.g. macOS Cmd+V) may run alongside P10, but report only adapter correctness until that desktop’s P10 companion can actually activate, capture and stop. Then time the native stop toggle or hold-release through confirmed insertion, labelling the gesture, failures and recovery. Never bypass protections, claim clipboard secrecy, double-paste or infer target correctness from history. Leave untested platforms unverified.

### Phase 12: Operate and distribute the companion

> Integrate the qualified recognition, library/import, polish, activation and delivery journeys as a Micme desktop release per [A1–A5](research-handy.md#application-controls-integrations-and-distribution). Ship tray/settings, model/language/unload, copy-last, accessible localized controls, library/drop UI, scoped diagnostics, login/hidden/no-tray and running-instance CLI/signals; assess a separate launcher integration without requiring it. Support portable data and signed or package-managed updates as appropriate. For each intended OS/architecture/backend/channel, supply permitted assets/notices, install/upgrade/uninstall and a native end-to-end dictation/recovery record; qualify offline and explicit online paths separately. Mark missing hardware, signing, translations, provider credentials or rights as limits, not passes. Keep the Pi package independently usable.

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Product shape | Preserve the Pi extension; add an optional local desktop companion sharing verified audio/model behavior. | Pi-only “parity”; mandatory desktop app or wholesale Handy fork. | Pi already gives safer direct prompt delivery, but cannot deliver a tray or OS-global key-up through its editor API. |
| Performance promise | Qualify a particular user journey/rig/model with matched evidence and named failure criteria. | Adopt headline ×RT, a best CLI run, one user’s paste timer, or Micme’s first draft as an app-wide SLA. | They measure different events, hardware, models and outputs. |
| Defaults and safety | Keep local review-first, explicit live RPC replay, no new retention/remote polish/warm mic by default. Enable optional benefits by informed choice. | Copy every Handy default, including five-item history, into every Pi installation. | Transfer recoverability and convenience without surprising people with persistent speech, cloud transmission or global clipboard use. |
| Reuse | Implement behavior under Micme branding; approve exact code, dependency, weight, asset and service rights before distribution. | Treat the app MIT license or a catalog label as blanket permission. | Brand exclusion, model-card conflicts, noncommercial/share-alike weights and separate native terms matter. |
| Stable reference | Track v0.10.2 behavior, publish the uncovered cells and dated upstream issue evidence. | Chase unmerged requests, count speculative features or silently substitute future Handy/main or Micme/PR behavior. | A versioned target is measurable and a later build request can deliberately rebaseline it. |

## Open questions

| Question | Who can answer | What waits for it |
| --- | --- | --- |
| Unverified: how do the two released experiences compare on the *same* user hardware, audio and observed target, and which stage dominates? | P1 paired measurements and a consenting native-device operator for physical-mic trials. | Numeric parity/default speed changes, not creation of the harness. |
| Unverified: which exact model exports, runtime builds and accelerator combinations work well enough for each language/task? | P3 artifact ledger and P4/P5 runtime/corpus qualification on the claimed devices. | Enabling/recommending that model for that task; not use of already verified local Whisper weights. |
| Unverified: which weights/assets/dependencies may be distributed or offered under Micme’s intended uses, especially Parakeet Unified and the bundled sounds? | Exact artifact owners’ terms, provenance and appropriate licensing review. | Affected download, bundle, mirror or reuse only; original artwork/sounds and other cleared models can proceed. |
| Unverified: which native target/OS/arch/display/locale combinations, signers and optional provider/launcher accounts are available for qualification? | Maintainers with the relevant device, service terms/access or release-channel signing authority. | Only the affected native claim, channel, adapter or translation. Initial Linux CPU/X11 and offline Pi objectives do not require those accounts. |
| Unverified: what is on the npm dist-tag or upstream branches when a build request starts? | Check the installed package, release and exact commit at that time. | Rebaseline P1 if different; do not promote a previously open OMP fix or Handy post-tag change without evidence. |

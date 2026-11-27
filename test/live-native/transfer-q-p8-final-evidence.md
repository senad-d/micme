# P8 final processing in Pi

[Clip, fixture-shortcut live and RPC observations](transfer-q-p8-final-observations.jsonl) and [production keyboard observations](transfer-q-p8-final-keyboard.jsonl) are from isolated Pi 1.6.0 on Linux x64, Node 24.22.3, at 40 and 80 columns. Their respective source-byte receipts are `4ee0ad2c33dee337e5469b692a5dd235e8a8415e4f298ef16b37109cded39d1a` and `685090d2bc8b8034ac35f94d26d4a4c7c34c4d785cfd22db4d38e8b1464bf78a` (`transfer-pi.mjs --source-sha256`, not commit or binary hashes). Excerpts omit setup chatter and redact disposable paths and ephemeral ports; editor snapshots, hook stdin and exact public fixture text are preserved. The trace JSONL is functional evidence, not a B-take ledger.

## Consent and pending clips

Opening consent sent nothing and did not start a capture or hook. The clip before the explicit action pasted its ordinary transcript once with no hook or provider request. The combined route showed the selected endpoint, model, prompt, key requirement and what leaves the device. In the hook-only run the configured provider was bypassed; the hook received the unpolished local final once and its result pasted once.

In the combined success runs the real loopback POST contained `Build p8_Q2 , version 17. Never send to production.` and the configured model and instruction. The fixture removed only the space before the comma. The actual Unix hook received that polished text once and prefixed it with `HOOK:`. With normal retention the hook found one already saved row containing separate raw and polished text and one WAV (16,044 bytes). Auto-submit made one idle send API call and no paste. In the confirmed `count:0` run the store generation advanced from `3` to `5` by hook entry; the hook saw zero rows and WAVs, and restart still found none. This was not a save failure: there was one paste and no warning. Replay in both runs gave the original text.

| Pending clip outcome | Editor pastes | Send requests | Notices |
| --- | ---: | ---: | --- |
| Success, confirmed `count:0`, auto-submit off | 1 | 0 | None |
| Success, history retained, auto-submit on | 0 | 1 idle | None |
| Successful empty stdout, auto-submit on | 0 | 0 | Informational suppression, not a hook error |
| Cancel after the sleeping hook started, auto-submit on | 0 | 0 | No fallback |
| HTTP 307 followed by a failing hook (keyless and authenticated runs) | 1 raw each | 0 | `polish: redirect blocked`, then `output hook: failed` |

Both redirect cases reached the selected listener once and never reposted to `Location`. Both origins were individually bridged into the network-restricted Pi. The reachability control from the same Pi then hit `Location` once in each trial. The received auth header was recorded as a boolean, not its value.

## Saved live final and explicit RPC replay

Each production keyboard run started with an existing composer draft, waited for a confirmed editor commit from the scripted worker, then typed an edit during capture and another after stop. **Alt+3** opened saved-live-final consent without submitting the draft. In the collision control, with Alt+3 configured for recording, **Alt+7** opened preview instead. The observer read exact editor text through its own readback key but did not register or relay either preview chord. Use `/micme preview` only from an empty composer: Pi clears the composer when dispatching a typed slash command.

Before consent, there were zero calls to either the provider or the hook, including ordinary live commits and stop. Across transform, successful empty stdout and Esc while the hook was pending (auto-submit on), plus a redirect/hook-error fallback (auto-submit off), preview added **zero** editor writes, sends or queues. Before and after editor readback were byte-identical. Typing `!` immediately afterward placed it inside `[after!]`, showing that focus and cursor returned to the existing draft. Nonempty success and fallback appeared outside the composer; empty and canceled runs never rendered a candidate. The ordered fallback warnings rendered outside the candidate. Explicit `/micme last` returned the original live final in all four runs.

A separate actual RPC session did not write, send or run processing during live dictation or when asked for the interactive preview. Explicit `/micme last` emitted one `set_editor_text` event with auto-submit off. With auto-submit on it made one idle send API call and one `followUp` call in a fixture-busy context; the fixture recorded the requests instead of exposing a model or opening a real queue.

## Replication and limits

The observations use the [isolated PTY launcher](transfer-pi-local.mjs) with deterministic Worker v1 and clip substitutes, paced generated PCM (no hardware microphone), a seeded Chat response and local test executables. No account, model completion, real ASR accuracy, cross-rig timing or performance pass is implied. See [provider evidence](transfer-q-p8-provider-evidence.md) for the compatible Messages wire checks and the hosted/Apple qualification limits. Media import and history UI are separate merge tasks; the independent final-journey check covers import/retry noninterference once those commands are present.

Regenerate the production keyboard receipts using the installed Pi test peer. The observer intercepts send attempts instead of starting a coding turn:

```bash
node test/live-native/transfer-q-p8-final-observe.mjs
```

The component, service and independent processing journey checks use the project runner:

```bash
node --test --test-reporter=dot test/transfer-processing-view.test.mjs test/transfer-final-services.test.mjs test/transfer-final.test.mjs
```

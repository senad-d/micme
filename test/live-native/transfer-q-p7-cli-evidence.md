# P7: installed WAV CLI evidence

## Offline file recognition

A clean npm prefix installed the local Micme tarball with `npm install --offline --ignore-scripts`. The installed `micme-transcribe` bin ran under Node 22.19.0 with type stripping disabled, on Linux x64 (Ubuntu 24.04, Intel Core i5-7500), outside the checkout. No Pi peers, Pi login, display or microphone were provisioned. A seccomp filter with thread synchronization blocked `socket` and `io_uring_setup` for Node and its descendants; the IPv4 socket positive control returned `EPERM`. Only the explicitly preprovisioned recognizer binaries and weights were available to the CLI.

Input was the public, prepared JFK WAV from the P4 fixtures; full WAV SHA-256 `d7d4e74b8a333ed02186008bc109a1b1a19d16da668bd56e785d80d69a16a72f` (176,000 samples at 16 kHz). The exact engine and model identities are in the [Q rows](transfer-q-p7-cli.jsonl). `--list-models --json` returned both exact native IDs and the resolved path for installed Whisper `ggml-tiny.en.bin`. No other model was listed. `--list-devices --json` returned:

```json
{"devices":[{"backend":"cpu","device":{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}},{"backend":"cpu","device":null}]}
```

Separate commands selected each listed model with `--device cpu --repeat 2 --json`. Each returned exit 0, one JSON document and no stderr. Observed output fields (the legacy model path is shortened to its basename):

| Model basenames | Requested | Actual backend | Bound device | Language | Samples | Run 1 / run 2 elapsed ms |
| --- | --- | --- | --- | --- | --- | --- |
| `moonshine-streaming-tiny-Q8_0.gguf` | `cpu` | `cpu` | `{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}` | `en` | 176000 | 596.4089659999997 / 614.619502 |
| `parakeet-tdt-0.6b-v3-Q4_K_M.gguf` | `cpu` | `cpu` | `{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}` | `en` | 176000 | 5194.3128830000005 / 3973.771979 |
| `ggml-tiny.en.bin` | `cpu` | `cpu` | `null` | `en` | 176000 | 806.1114350000003 / 831.2101860000002 |

For each native variant, `text` was “And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.” Whisper returned the same words with no comma after “so” or “Americans”. The separate plain-text Moonshine invocation wrote only the transcript to stdout; stderr printed the requested and observed CPU, reported runtime label and `Run 1: 643.212 ms`. Legacy Whisper on the public digital-zero fixture with `--device auto` returned empty text, 160,000 samples, `device: "unknown"`, and `boundDevice: null`. Enumeration is not evidence of a binding.

| Negative test with the installed bin | Exit | Observed diagnostic |
| --- | --- | --- |
| Truncated WAV | 2 | `Expected a complete, nonempty 16 kHz mono signed 16-bit PCM WAV.` |
| Exact native model selected against an empty weights directory | 1 | `Model is not installed or qualified. Provision local weights and check --list-models; this command never downloads weights.` |
| Unlisted device ID | 1 | `Device is not available as a backend or unique device ID. Choose --device auto or check --list-devices.` |

All three failures had empty stdout. Importing the installed CLI produced no output. The isolated config enabled history, auto-submit, custom recorder/transcriber commands, final processing, output hook and auto-download: no tool trap fired and no history files appeared. The only agent-directory entry remained the preseeded config; the temporary audio directory and missing-model directory were empty after the runs, and the JFK input digest was unchanged.

## Independent package boundary

The 118-entry local tarball (SHA-256 `cdd11d77b7a4d59fcecb244212fe426eb109b029a5c9a5fba978b53dd889519a`) contained both compiled executable targets, all Worker v1 sources and the optional recognizer's CMake inputs, source and build/notice guide. Clean installation exposed both bins, with no Pi/GUI packages: the only other installed dependencies were `koffi` and its prebuilt platform package. No weights, audio fixtures or built helper executables were packed. The optional Apple source was not yet present in this checkout; the guard fixture covered including only its exact source and refusing its compiled executable.

The separate Node 22.19.0 doctor suite passed all 7 tests, including a compiled doctor in an isolated directory without Pi peers or type stripping, local model/backend resolution and a Worker v1 version-only probe. The two package guard suites passed 11 tests. The CLI unit suite passed 7 tests, including distinct fixture IDs for two devices sharing one backend, explicit selection and an observed loaded label that differs from the listing. Fixture devices do not establish native GPU support. The installed CPU checks are F2 functional evidence, not A4 qualification or latency comparisons; the repeats are individual timings without a paired baseline.

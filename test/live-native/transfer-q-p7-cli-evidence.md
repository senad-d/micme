# P7: installed WAV CLI evidence

## Offline file recognition

A clean npm prefix installed the local Micme tarball with `npm install --offline --ignore-scripts`. The installed `micme-transcribe` bin ran under Node 22.19.0 with type stripping disabled, on Linux x64 (Ubuntu 24.04, Intel Core i5-7500), outside the checkout. No Pi peers, Pi login, display or microphone were provisioned. A seccomp filter with thread synchronization blocked `socket` and `io_uring_setup` for Node and its descendants; the IPv4 socket positive control returned `EPERM`. Only the explicitly preprovisioned recognizer binaries and weights were available to the CLI.

Input was the public, prepared JFK WAV from the P4 fixtures; full WAV SHA-256 `d7d4e74b8a333ed02186008bc109a1b1a19d16da668bd56e785d80d69a16a72f` (176,000 samples at 16 kHz). The exact engine and weight digests are in the [Q rows](transfer-q-p7-cli.jsonl). `--list-models --json` returned only these installed IDs:

```text
moonshine-streaming-tiny/Q8_0@3b75b3ab1d29bee2112deb73514de0657337db559134956af809d3dd70231174
parakeet-tdt-0.6b-v3/Q4_K_M@536c7023afb9030c8e6f4d238607c7dc5d9b5b27361a79e8ff4139321822cab4
whisper.cpp/tiny.en/F16@3895f9f0b9e33cdb6ec5585758804e59cfeabf43d5ef88704250b2385f5736ee
```

`--list-devices --json` returned:

```json
{"devices":[{"backend":"cpu","device":{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}},{"backend":"cpu","device":null}]}
```

Separate commands selected each listed model with `--device cpu --repeat 2 --json`. Each returned exit 0, one JSON document and no stderr. The table uses weight basenames and rounds elapsed time to three decimals:

| Weight basename | Requested | Actual backend | Bound device | Language | Samples | Run 1 / run 2 elapsed ms |
| --- | --- | --- | --- | --- | --- | --- |
| `moonshine-streaming-tiny-Q8_0.gguf` | `cpu` | `cpu` | `{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}` | `en` | 176000 | 916.582 / 610.892 |
| `parakeet-tdt-0.6b-v3-Q4_K_M.gguf` | `cpu` | `cpu` | `{"id":null,"label":"Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz"}` | `en` | 176000 | 4089.473 / 4005.942 |
| `ggml-tiny.en.bin` | `cpu` | `cpu` | `null` | `en` | 176000 | 966.480 / 1036.407 |

For each native variant, `text` was “And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.” Whisper returned the same words with no comma after “so” or “Americans”. The separate plain-text Moonshine invocation wrote only the transcript to stdout; stderr printed the requested and observed CPU, reported runtime label and `Run 1: 609.312 ms`. Legacy Whisper on the public digital-zero fixture with `--device auto` returned empty text, 160,000 samples, `device: "unknown"`, and `boundDevice: null`. Enumeration is not evidence of a binding.

| Negative test with the installed bin | Exit | Observed diagnostic |
| --- | --- | --- |
| Truncated WAV | 2 | `Expected a complete, nonempty 16 kHz mono signed 16-bit PCM WAV.` |
| Exact native model selected against an empty weights directory | 1 | `Model is not installed or qualified. Provision local weights and check --list-models; this command never downloads weights.` |
| Unlisted device ID | 1 | `Device is not available as a backend or unique device ID. Choose --device auto or check --list-devices.` |

All three failures had empty stdout. Importing the installed CLI produced no output. The isolated config enabled history, auto-submit, custom recorder/transcriber commands, final processing, output hook and auto-download: no tool trap fired and no history files appeared. The only agent-directory entry remained the preseeded config; the temporary audio directory and missing-model directory were empty after the runs, and the JFK input digest was unchanged.

## Independent package boundary

The 128-entry local tarball (SHA-256 `c408dc54b4b15c4ecd1fc1eef5b6b0b0aa8aa325a2a35d7c5e0a494e6d7ef479`) contained both compiled bin targets, all Worker v1 sources, the optional recognizer's CMake inputs, source and build/notice guide, and the optional Apple helper's Swift source. Clean installation without omitting peers exposed both bins, with no Pi/GUI packages: the only other installed dependencies were `koffi` and its platform package. No weights, audio fixtures or built helper executables were packed.

The separately installed doctor smoke passed with type stripping disabled and a version-only Worker v1 probe. The Node 22.19.0 scoped check passed 31 CLI, package guard and doctor unit tests; six additional packlist tests verified the source allowlist and guarded against Pi becoming a runtime dependency. The CLI tests cover distinct fixture IDs for two devices sharing a backend, explicit selection and an observed label that differs from its listing. Fixture devices do not establish native GPU support. The installed CPU checks are F2 functional evidence, not A4 qualification or latency comparisons; the repeats are individual timings without a paired baseline.

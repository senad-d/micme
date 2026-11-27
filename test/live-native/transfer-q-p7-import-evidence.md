# P7 local media import: functional evidence

[Public receipts](transfer-q-p7-import-receipts.json) come from real FFmpeg/ffprobe 6.1.1 and the installed CPU `whisper-cli` (1.9.6-dev, exact binary hash in the receipts). The collector only uses the public-domain JFK fixture and the pinned `tiny.en` model supplied on the command line. It uses a disposable library and does not launch Pi, a microphone, or a provider. These are functional observations, not latency comparisons or device qualification.

## Replay

Use Node 24 and a local FFmpeg/ffprobe build with the seekable `fd:` protocol. There is intentionally no fallback to opening a pathname or to a network-enabled protocol. MP4 files with indexes after the media data need a seekable input. Supply the untouched upstream `samples/jfk.wav`, installed `whisper-cli`, and `ggml-tiny.en.bin`; verify their digests against the receipts. For the fixture generation the FFmpeg build must also supply Opus, AAC and MPEG-4 encoders.

```bash
node --test --test-reporter=dot test/media-import.test.mjs
node test/live-native/transfer-q-p7-import-observe.mjs "$JFK_WAV" "$WHISPER_CLI" "$TINY_EN"
```

## Observations

| Condition | Direct observation |
| --- | --- |
| Mixed Opus and MP4 | Both ready with separate raw and local text; 176,000 and 176,128 mono 16 kHz PCM16 samples. Library PCM digests matched the recognition input; each original's digest was unchanged. The MP4's first audio track contains speech; its default track is silent. |
| No audio, malformed, unsupported codec, external reference | Four separate failed rows without audio. The unknown WAV codec reports FFmpeg's missing decoder; no-audio reports a distinct error. The local concat control opens under ordinary ffprobe, but import rejects it. A remote URL and a symlink are also rejected in the component suite. |
| Pinned source, decoder cancellation | The component checks reject an equal-byte swap of a queued source and a valid substitute at the staged output name. Another check stops an owned decoder after it writes partial WAV data; cancel leaves neither a published WAV nor staging output. |
| Progress, cancel, explicit retry | The 44-second repeated public fixture persisted progress at 640,000 / 704,000 samples with `chunking=false`. A foreground reservation blocked the next chunk. Cancel retained the verified digest without a late final; explicit installed-model retry recognized all 704,000 samples from the same WAV. The component suite separately cancels a queued sibling while the first job is active. |
| Restart | A killed child process with real library jobs is reopened. Both the recognizing and queued rows are interrupted; only the already-published WAV verifies for retry. The other row needs explicit source reselection. The inference boundary was held by a test adapter for this failure injection. |
| Priority and fixed selection | At the scheduler boundary a controlled engine observed `first import chunk → foreground → explicit retry → remainder of first import → later import`. Mutating the caller's model selection did not change either chunk of the first job; its stored model ID remained fixed. This is a component observation, not a live Pi capture. |
| Retention and isolation | Confirmed `count:0` retained the three verified imported WAVs. Explicit deletion removed the selected row and WAV. With auto-submit enabled and an executable output-hook marker configured, the marker was absent after the mixed batch, its errors, cancellation and retry. |

The actual Pi prompt, send/queue counts, and interruption by a real live take are not observed by this backend collector. Verify those in the independent V5 file journey; there are no matched B comparison takes for these checks.

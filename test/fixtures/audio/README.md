# Micme audio fixtures

These ten 16 kHz mono signed 16-bit PCM WAVs are ready to play or feed to a clip backend. For Micme stream mode, pass a WAV to the [paced recorder](../../live-native/README.md#run-and-replay), which produces the growing WAV that live capture expects. Use a multilingual model with language `fr` for French or `ru` for Russian. No downloads are needed to get these clips; the native benchmark still uses its separate external asset cache, and these files are not in the npm package.

The [human reference transcripts](references.json) are keyed by filename. The rain clip has no spoken words.

| WAV | Duration | Content |
| --- | ---: | --- |
| [english-commission.wav](english-commission.wav) | 7.58 s | Commission report, English |
| [english-continuous.wav](english-continuous.wav) | 36.29 s | Five English audiobook excerpts with short joins |
| [english-dumas.wav](english-dumas.wav) | 23.32 s | One sustained English audiobook reading |
| [english-jfk.wav](english-jfk.wav) | 11.00 s | English archival speech |
| [english-natural-history.wav](english-natural-history.wav) | 8.40 s | English nonfiction passage |
| [english-quiet.wav](english-quiet.wav) | 3.85 s | Quiet English speech |
| [english-thank-you.wav](english-thank-you.wav) | 1.84 s | Short English speech |
| [french-paris.wav](french-paris.wav) | 1.67 s | French pronunciation of “Paris” |
| [rain-noise.wav](rain-noise.wav) | 10.00 s | Rain and a door transient; no spoken words |
| [russian-birthday.wav](russian-birthday.wav) | 3.89 s | Russian sentence |

## Measure transcription quality and speed

From a checkout with `npm ci` and the project's Node version, give the runner a local `whisper-cli` and a multilingual Whisper model (for example, `ggml-base.bin`, not `ggml-base.en.bin`). See the [native benchmark guide](../../live-native/README.md#provision-once) for the pinned CLI build and weights. This command needs no microphone, VAD model, external corpus, or network after setup:

```bash
npm run --silent test:audio-quality -- /path/to/whisper-cli /path/to/ggml-base.bin > micme-audio-quality.json
```

The JSON records the binary and model SHA-256s and host details. The runner transcribes each WAV once, sequentially, using Micme's whisper.cpp clip path and that fixture's language. It reports:

- **Speech quality:** reference and output, substitutions, deletions, insertions, and word error rate (WER). Corpus WER divides total errors by total reference words. Scoring ignores case, treats punctuation as word boundaries except for apostrophes within words, and does not equate written numbers with spelled-out numbers.
- **Non-speech:** whether any text was emitted, its word count using the same scoring rules, and the output itself so you can tell a sound label from invented speech. Non-speech has no WER and is excluded from corpus WER.
- **Speed:** per-clip wall time includes the process launch, model load, decoding, and transcript read. The real-time factor is wall time ÷ audio duration (below `1` is faster than real time); the corpus factor uses the totals. It does not measure microphone capture, preprocessing, or live draft latency. Compare runs on the same host with the same CLI/model and similar load.

This is an opt-in diagnostic, not a quality or speed gate. A transcriber failure is recorded for that clip, is excluded from aggregates, and makes the command exit nonzero while preserving the JSON results for the other clips. The separate native benchmark measures live behavior.

## Sources and reuse

Six WAVs match cases from the [pinned native corpus recipe](../../live-native/corpus.mjs). The licenses below apply to the identified materials, not the Micme code. Keep the listed credits, source links and license notices when redistributing CC BY or CC BY-SA material.

- `english-jfk.wav`: John F. Kennedy's January 20, 1961 inaugural address ([archival recording and rights](https://commons.wikimedia.org/wiki/File:JFK_inaugural_address.ogg)), U.S. public domain as a federal work. The [pinned whisper.cpp excerpt](https://github.com/ggml-org/whisper.cpp/blob/96ec4d9823e9d0211944172da35f9f29134af990/samples/jfk.wav) was rewrapped without changing the PCM.
- `english-quiet.wav` and `english-continuous.wav`: [LibriSpeech dev-clean](https://www.openslr.org/12/) (© 2014 Vassil Panayotov), with [pinned alignments distributed by gilkeyio](https://huggingface.co/datasets/gilkeyio/librispeech-alignments/tree/0daa1eb43dda38ee6ce752e785555380e5628f5c); [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Quiet is Peter Eastman reading *The Passionate Friends* (`174-84280-0011`), trimmed to the phrase, attenuated by 18 dB, and padded. Continuous trims, joins and pads five [aligned utterances](../../live-native/alignment.json), read for LibriVox by Peter Eastman, badey, S R Colon, JudyGibson and calystra, in that order.
- `english-dumas.wav`: Nolan Fout reading Alexandre Dumas's *Ten Years Later*, “11 - Night,” for [LibriVox](https://librivox.org/ten-years-later-by-alexandre-dumas/). Audio and reference from utterance `6930-75918-0003` in [LibriSpeech test-clean](https://www.openslr.org/12/) (© 2014 Vassil Panayotov), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Converted from FLAC without trimming.
- `english-commission.wav` and `english-natural-history.wav`: Linda Johnson reading for LibriVox, segmented and annotated by Keith Ito in [LJ Speech](https://keithito.com/LJ-Speech-Dataset/) ([`LJ037-0171`](https://keithito.com/LJ-Speech-Dataset/LJ037-0171.wav) and [`LJ025-0076`](https://keithito.com/LJ-Speech-Dataset/LJ025-0076.wav), respectively). The publisher identifies the recordings and text as U.S. public domain. Resampled from 22.05 kHz without trimming.
- `english-thank-you.wav`: [“Thank you”](https://commons.wikimedia.org/wiki/File:En-us-thank_you_1.ogg) by Mx. Granger, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Converted from Ogg and padded with silence.
- `french-paris.wav`: [“Paris Pronunciation in French”](https://commons.wikimedia.org/wiki/File:Paris_Pronunciation_in_French_by_James_Tamim.ogg) by James Tamim. Converted from Ogg and padded with silence. This WAV is distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); keep the attribution and use the same or a compatible license when distributing adaptations.
- `rain-noise.wav`: [“unlocki door to mod rain.wav”](https://freesound.org/s/17367/) by cognito perceptu (CC0), via ESC-10 sample [`1-17367-A-10`](https://github.com/karolpiczak/ESC-50/blob/f2fd956acf66ebd9ac7e2110711aa78dd684d042/audio/1-17367-A-10.wav), curated by Karol J. Piczak. The [pinned ESC-10 subset](https://github.com/karolpiczak/ESC-50/blob/f2fd956acf66ebd9ac7e2110711aa78dd684d042/LICENSE) is [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), retained here. Converted to mono 16 kHz and repeated once.
- `russian-birthday.wav`: [Tatoeba audio `1278607`](https://tatoeba.org/en/audio/download/1278607) by [retr0ra1n](https://tatoeba.org/en/user/profile/retr0ra1n), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), converted from MP3. The underlying [sentence `5413`](https://tatoeba.org/en/sentences/show/5413) by [Olya](https://tatoeba.org/en/user/profile/Olya) is separately licensed under [CC BY 2.0 France](https://creativecommons.org/licenses/by/2.0/fr/).

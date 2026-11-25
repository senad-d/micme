#include "decoder.hpp"

#include <whisper.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using Sample = std::int64_t;
using Clock = std::chrono::steady_clock;
constexpr int rate = 16000;
constexpr int vad_frame = 512; // Silero 16 kHz window, including the pinned v5.1.2 model.
constexpr int onset = 2 * vad_frame;
constexpr int preroll = rate / 4;
constexpr int release = rate / 2;
constexpr int tail = rate / 5;
constexpr int rollover = 20 * rate;
constexpr int overlap = rate;
constexpr int preview_step = ((rate + vad_frame - 1) / vad_frame) * vad_frame;
constexpr std::size_t max_line = 64 * 1024;

struct Diagnostics {
    std::atomic<bool> failed{false};
};

void upstream_log(ggml_log_level level, const char *, void *data) {
    // Whisper and ggml logs may contain paths, and VAD logs at every call.
    // Report bounded, component-specific errors instead. In this pin a VAD
    // graph failure can log ERROR and still return true from the outer call.
    if (level == GGML_LOG_LEVEL_ERROR) static_cast<Diagnostics *>(data)->failed = true;
}

void emit(const std::string &line) {
    if (line.size() + 1 > max_line) throw std::runtime_error("Live decoder event exceeds the protocol line limit.");
    if (std::fwrite(line.data(), 1, line.size(), stdout) != line.size() ||
        std::fputc('\n', stdout) == EOF || std::fflush(stdout) == EOF) {
        throw std::runtime_error("Could not write the live decoder event.");
    }
}

std::string json_string(std::string_view text) {
    std::string result = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (std::size_t i = 0; i < text.size();) {
        const auto lead = static_cast<unsigned char>(text[i]);
        if (lead < 0x80) {
            if (lead == '"' || lead == '\\') result += '\\';
            if (lead < 0x20) {
                result += "\\u00";
                result += hex[lead >> 4];
                result += hex[lead & 15];
            } else {
                result += text[i];
            }
            ++i;
            continue;
        }
        const std::size_t size = lead >= 0xc2 && lead <= 0xdf ? 2 :
                                 lead >= 0xe0 && lead <= 0xef ? 3 :
                                 lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        bool valid = size != 0 && size <= text.size() - i;
        for (std::size_t j = 1; valid && j < size; ++j) {
            const auto byte = static_cast<unsigned char>(text[i + j]);
            valid = byte >= 0x80 && byte <= 0xbf;
            if (j == 1 && ((lead == 0xe0 && byte < 0xa0) || (lead == 0xed && byte > 0x9f) ||
                           (lead == 0xf0 && byte < 0x90) || (lead == 0xf4 && byte > 0x8f))) valid = false;
        }
        if (valid) {
            result.append(text.substr(i, size));
            i += size;
        } else {
            result += "\\ufffd";
            ++i;
        }
    }
    result += '"';
    return result;
}

void text_event(const char *type, Sample from, Sample to, const std::string &text) {
    emit(std::string("{\"type\":\"") + type + "\",\"from\":" + std::to_string(from) +
         ",\"to\":" + std::to_string(to) + ",\"text\":" + json_string(text) + "}");
}

struct Options {
    const char *model = nullptr;
    const char *vad = nullptr;
    const char *language = nullptr;
    bool translate = false;
};

Options parse_options(int argc, char **argv) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::string_view key(argv[i]);
        if (key == "--translate" && !options.translate) {
            options.translate = true;
            continue;
        }
        const char **target = key == "--model" ? &options.model : key == "--vad-model" ? &options.vad :
                              key == "--language" ? &options.language : nullptr;
        if (!target || *target || ++i == argc || argv[i][0] == '\0') {
            throw std::runtime_error("Expected --model PATH --vad-model PATH --language CODE [--translate].");
        }
        *target = argv[i];
    }
    if (!options.model || !options.vad || !options.language) {
        throw std::runtime_error("ASR model, VAD model and language are required.");
    }
    return options;
}

std::int64_t micros_since(Clock::time_point start) {
    return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count();
}

void read_exact(void *out, std::size_t size) {
    if (std::fread(out, 1, size, stdin) != size) throw std::runtime_error("Truncated live PCM frame.");
}

struct Piece {
    Sample from;
    Sample to;
    std::string text;
    float confidence = 0; // weakest lexical token; punctuation does not determine word confidence

    Sample midpoint() const { return from + (to - from) / 2; }
};

struct Hypothesis {
    std::string text;
    std::vector<Piece> pieces;
    bool placeable = true;

    std::size_t first_owned(Sample from) const {
        return std::lower_bound(pieces.begin(), pieces.end(), from, [](const Piece &piece, Sample time) {
            return piece.midpoint() < time;
        }) - pieces.begin();
    }

    std::string owned(std::size_t first, Sample to) const {
        std::string result;
        for (; first < pieces.size() && pieces[first].midpoint() < to; ++first) result += pieces[first].text;
        return result;
    }
};

bool punctuation(unsigned char ch) {
    return ch <= ' ' || (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
           (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~');
}

std::string seam_word(std::string_view text) {
    while (!text.empty() && punctuation(text.front())) text.remove_prefix(1);
    while (!text.empty() && punctuation(text.back())) text.remove_suffix(1);
    if (text.find_first_of(" \t\r\n") != std::string_view::npos) return {}; // A segment, not a timed word.
    std::string key(text);
    for (auto &ch : key) if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
    return key;
}

// A weak word at the newest edge may be a cut-off word or a guess. Earlier
// agreement at the same audio position can confirm it without another decode.
class DraftAgreement {
public:
    void clear() { previous_.clear(); }

    std::string update(const Hypothesis &draft, std::size_t first, Sample end) {
        auto stop = draft.pieces.size();
        // Only trim the speculative right edge. Keep an uncertain interior
        // word in context and don't put a lower-confidence tail back merely
        // because it appeared in another part of the recording.
        while (stop > first + 1 && !established(draft.pieces[stop - 1], end)) --stop;
        previous_.clear();
        for (auto i = first; i < draft.pieces.size(); ++i) {
            const auto &word = draft.pieces[i];
            if (word.midpoint() >= end - history) previous_.push_back({word.midpoint(), seam_word(word.text)});
        }
        std::string text;
        for (auto i = first; i < stop; ++i) text += draft.pieces[i].text;
        return text;
    }

private:
    static constexpr Sample history = 4 * rate;
    static constexpr Sample drift = rate / 2;
    struct Word { Sample at; std::string key; };

    bool established(const Piece &piece, Sample end) const {
        const auto age = end - piece.to;
        if (age >= 3 * rate / 2 || piece.confidence >= (age >= 3 * rate / 4 ? 0.55f : 0.75f)) return true;
        const auto key = seam_word(piece.text);
        return !key.empty() && std::any_of(previous_.begin(), previous_.end(), [&](const Word &old) {
            return key == old.key && std::abs(piece.midpoint() - old.at) <= drift;
        });
    }

    std::vector<Word> previous_;
};

class Seam {
public:
    void clear() { words_.clear(); }

    void remember(const Hypothesis &left, Sample from, Sample cut, Sample through) {
        words_.clear();
        for (const auto &piece : left.pieces) {
            if (piece.midpoint() < from || piece.midpoint() >= through) continue;
            words_.push_back({piece.midpoint(), seam_word(piece.text)});
        }
        cut_ = cut;
    }

    std::size_t first_owned(const Hypothesis &right, Sample cut) const {
        const auto by_time = right.first_owned(cut);
        if (words_.empty() || cut != cut_) return by_time;
        // Independently decoded token times can drift in either direction.
        // A short matching sequence, at nearby times in the *same* overlap,
        // transfers ownership at the old boundary, including the first new
        // word if its estimated time moved left. Ties prefer closest times.
        constexpr Sample drift = rate * 3 / 5;
        std::size_t best_length = 1;
        Sample best_error = 0;
        std::size_t first = by_time;
        const auto split = std::lower_bound(words_.begin(), words_.end(), cut, [](const Word &word, Sample time) {
            return word.at < time;
        }) - words_.begin();
        std::vector<std::string> keys;
        for (const auto &piece : right.pieces) {
            if (piece.midpoint() >= words_.back().at + drift) break;
            keys.push_back(seam_word(piece.text));
        }
        for (std::size_t l = 0; l < static_cast<std::size_t>(split); ++l) {
            for (std::size_t r = 0; r < keys.size(); ++r) {
                Sample error = 0;
                std::size_t length = 0;
                while (l + length < words_.size() && r + length < keys.size()) {
                    const auto &word = words_[l + length];
                    const auto distance = std::abs(word.at - right.pieces[r + length].midpoint());
                    if (word.key.empty() || word.key != keys[r + length] || distance > drift) break;
                    error += distance;
                    ++length;
                }
                if (l + length < static_cast<std::size_t>(split) || length < 2 ||
                    (length < best_length || (length == best_length && error >= best_error))) continue;
                best_length = length;
                best_error = error;
                first = r + split - l;
            }
        }
        return first;
    }

private:
    struct Word { Sample at; std::string key; };
    std::vector<Word> words_;
    Sample cut_ = 0;
};

// Use word-sized groups, not individual UTF-8/BPE fragments, at a cut. If
// any group lacks usable time, use the containing segment instead.
std::vector<Piece> timed_words(whisper_context *ctx, int segment, Sample start, Sample end) {
    const auto special = whisper_token_eot(ctx);
    std::vector<Piece> words;
    for (int i = 0; i < whisper_full_n_tokens(ctx, segment); ++i) {
        const auto token = whisper_full_get_token_data(ctx, segment, i);
        if (token.id >= special) continue;
        const std::string_view text(whisper_full_get_token_text(ctx, segment, i));
        if (text.empty()) continue;
        if (token.t0 < 0 || token.t1 < token.t0 || token.t0 >= (end - start + 159) / 160) return {};
        const auto from = start + token.t0 * 160;
        const auto to = start + std::min<Sample>(token.t1, (end - start + 159) / 160) * 160;
        const auto lexical = !std::all_of(text.begin(), text.end(), punctuation);
        if (!words.empty() && text.front() != ' ') {
            if (from < words.back().from || to < words.back().to) return {};
            words.back().to = std::min(to, end);
            words.back().text += text;
            if (lexical) words.back().confidence = std::min(words.back().confidence, token.p);
        } else {
            if (!words.empty() && from < words.back().to) return {};
            words.push_back({from, std::min(to, end), std::string(text), lexical ? token.p : 1.0f});
        }
    }
    // Time quantization can put an entire short word on one tick. Its
    // position is still usable for midpoint ownership.
    return words;
}

Hypothesis collect(whisper_context *ctx, Sample start, Sample end, bool need_times) {
    Hypothesis result;
    const auto limit = (end - start + 159) / 160;
    for (int i = 0; i < whisper_full_n_segments(ctx); ++i) {
        const std::string text(whisper_full_get_segment_text(ctx, i));
        if (text.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        result.text += text;
        if (!need_times) continue;
        const auto t0 = whisper_full_get_segment_t0(ctx, i);
        const auto t1 = whisper_full_get_segment_t1(ctx, i);
        auto words = timed_words(ctx, i, start, end);
        if (!words.empty() && (result.pieces.empty() || words.front().from >= result.pieces.back().to)) {
            for (auto &word : words) result.pieces.push_back(std::move(word));
        } else if (t0 >= 0 && t0 < limit && t1 > t0 &&
                   (result.pieces.empty() || start + t0 * 160 >= result.pieces.back().to)) {
            result.pieces.push_back({start + t0 * 160, std::min(start + std::min(t1, limit) * 160, end), text});
        } else {
            result.placeable = false;
        }
    }
    return result;
}

enum class Decode { Preview, Endpoint, Rollover };

class Decoder {
public:
    Decoder(const Options &options, Diagnostics &diagnostics)
        : diagnostics_(diagnostics), language_(options.language), translate_(options.translate) {
        const bool automatic = language_ == "auto";
        const int id = automatic ? -1 : whisper_lang_id(language_.c_str());
        if (!automatic && (id < 0 || language_ != whisper_lang_str(id))) {
            throw std::runtime_error("Unknown Whisper language code. Select a supported source language or auto.");
        }
        const auto start = Clock::now();
        asr_.reset(whisper_init_from_file_with_params(options.model, whisper_context_default_params()));
        if (!asr_) throw std::runtime_error("Could not load the Whisper ASR model. Check MICME_WHISPER_CPP_MODEL or choose clip mode.");
        heavy_encoder_ = whisper_model_n_audio_layer(asr_.get()) > 6;
        if (!whisper_is_multilingual(asr_.get())) {
            if (translate_ || (!automatic && id != whisper_lang_id("en"))) {
                throw std::runtime_error("The English-only ASR model cannot recognize or translate the selected language.");
            }
            language_ = "en";
        } else if (translate_ && whisper_model_n_audio_layer(asr_.get()) == 32 &&
                   whisper_model_n_text_layer(asr_.get()) == 4) {
            throw std::runtime_error("The Turbo ASR model does not support translation. Select a translation-capable model.");
        }
        auto vad_params = whisper_vad_default_context_params();
        vad_params.n_threads = 1;
        vad_params.use_gpu = false;
        vad_.reset(whisper_vad_init_from_file_with_params(options.vad, vad_params));
        if (!vad_) throw std::runtime_error("Could not load the Silero VAD model. Check MICME_VAD_MODEL or choose clip mode.");
        check_vad_window();
        emit("{\"type\":\"ready\",\"version\":1,\"rate\":16000,\"loadMs\":" +
             std::to_string(micros_since(start) / 1000.0) + ",\"asrLoads\":1,\"vadLoads\":1}");
    }

    void run() {
        std::array<unsigned char, 2 * rate> bytes;
        for (;;) {
            const auto type = std::fgetc(stdin);
            if (type == 3) break;
            if (type == EOF) throw std::runtime_error("Live PCM input closed without finish.");
            if (type != 1 && type != 2) throw std::runtime_error("Unknown live PCM frame type.");
            std::array<unsigned char, 4> size;
            read_exact(size.data(), size.size());
            const std::uint32_t count = std::uint32_t(size[0]) | (std::uint32_t(size[1]) << 8) |
                                        (std::uint32_t(size[2]) << 16) | (std::uint32_t(size[3]) << 24);
            if (count == 0 || count > rate) throw std::runtime_error("Invalid live PCM frame sample count.");
            read_exact(bytes.data(), 2 * count);
            for (std::uint32_t i = 0; i < count; ++i) {
                const int value = int(bytes[2 * i]) | (int(bytes[2 * i + 1]) << 8);
                audio_.push_back((value >= 32768 ? value - 65536 : value) / 32768.0f);
            }
            received_ += count;
            const bool previews = type == 1;
            detect((received_ - scanned_) / vad_frame * vad_frame, false, previews);
            const auto end = quiet_since_ < 0 ? scanned_ : std::min(scanned_, quiet_since_ + tail);
            if (previews && active_ && voiced_ >= rate && end - preview_at_ >= preview_step) preview(end);
            trim_idle_audio();
            emit("{\"type\":\"ack\",\"through\":" + std::to_string(received_) + "}");
        }
        detect(received_ - scanned_, true);
        if (active_ && received_ > frontier_) finalize(received_);
        emit("{\"type\":\"done\",\"through\":" + std::to_string(received_) + ",\"asrCalls\":" +
             std::to_string(asr_calls_) + ",\"asrMs\":" + std::to_string(asr_us_ / 1000.0) +
             ",\"vadFrames\":" + std::to_string(vad_frames_) + "}");
    }

private:
    void check_vad_window() {
        // The pinned API exposes the probabilities but not the model's frame
        // size. ceil(n/window) must be one at 512 and two at 513. Reset the
        // probe's recurrent state before accepting any captured audio.
        std::array<float, vad_frame + 1> silence{};
        whisper_vad_reset_state(vad_.get());
        diagnostics_.failed = false;
        if (!whisper_vad_detect_speech_no_reset(vad_.get(), silence.data(), vad_frame) ||
            whisper_vad_n_probs(vad_.get()) != 1 ||
            !whisper_vad_detect_speech_no_reset(vad_.get(), silence.data(), vad_frame + 1) ||
            whisper_vad_n_probs(vad_.get()) != 2 || diagnostics_.failed) {
            throw std::runtime_error("Unsupported Silero VAD frame size or failed startup probe. Check MICME_VAD_MODEL.");
        }
        whisper_vad_reset_state(vad_.get());
    }

    Sample preview_limit() const { return heavy_encoder_ ? 13 * rate / 2 : 10 * rate; }

    void preview(Sample end) {
        preview_at_ = end;
        // Prefer a nearby acoustic boundary to starting mid-word. This does
        // not wait for a pause or extend the preview's inference budget.
        auto start = std::max(decode_from_, end - preview_limit());
        if (start > decode_from_) {
            const auto gap = std::lower_bound(pauses_.begin(), pauses_.end(), start);
            if (gap != pauses_.end() && *gap - start <= rate / 2) start = *gap;
        }
        const auto from = std::max(start, frontier_);
        const bool has_overlap = start < frontier_;
        const auto window = decode_window(start, end, has_overlap || !translate_, Decode::Preview);
        if (!window.placeable || window.pieces.empty()) {
            draft_.clear();
            text_event("partial", from, end, has_overlap ? "" : window.text);
            return;
        }
        const auto first = has_overlap ? seam_.first_owned(window, from) : std::size_t{0};
        text_event("partial", from, end, translate_ ? window.owned(first, end) : draft_.update(window, first, end));
    }

    Hypothesis decode_window(Sample start_sample, Sample end, bool need_times, Decode mode) {
        const auto length = end - start_sample;
        if (length <= 0 || length > 28 * rate) throw std::runtime_error("Live ASR window outside its allowed bounds.");
        const bool drafting = mode == Decode::Preview;
        auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads = static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 4u));
        params.greedy.best_of = 1;
        params.temperature_inc = 0.0f;
        params.no_context = true;
        params.suppress_nst = true;
        params.token_timestamps = need_times;
        params.print_progress = params.print_realtime = params.print_timestamps = params.print_special = false;
        params.language = language_.c_str();
        params.translate = translate_;
        // A shortened encoder can change recognition on brief VAD spans.
        // Keep native context there. Drafts have a fixed budget; rollover
        // already has a long voiced window and needs to unblock the next draft.
        if (drafting && heavy_encoder_) {
            // Avoid serial re-encodes of the same draft on deeper models.
            params.audio_ctx = std::min(whisper_n_audio_ctx(asr_.get()), 420);
            params.single_segment = true;
            params.max_tokens = 80;
        } else if (drafting) {
            params.audio_ctx = std::min(whisper_n_audio_ctx(asr_.get()),
                                        std::max(384, static_cast<int>((length + 319) / 320) + 100));
            params.single_segment = true;
            params.max_tokens = 72;
        } else if (mode == Decode::Rollover && heavy_encoder_) {
            params.audio_ctx = std::min(whisper_n_audio_ctx(asr_.get()), static_cast<int>((length + 319) / 320) + 100);
            params.single_segment = true;
        }
        params.no_timestamps = mode == Decode::Endpoint && !need_times;
        const float *pcm = audio_.data() + (start_sample - audio_start_);
        std::array<float, rate / 10> short_window{};
        if (length < static_cast<Sample>(short_window.size())) {
            std::copy_n(pcm, length, short_window.begin());
            pcm = short_window.data();
        }
        const auto start = Clock::now();
        ++asr_calls_;
        diagnostics_.failed = false;
        if (whisper_full(asr_.get(), params, pcm, std::max<int>(length, short_window.size())) != 0 || diagnostics_.failed) {
            throw std::runtime_error("Whisper ASR inference failed.");
        }
        asr_us_ += micros_since(start);
        if (language_ == "auto") {
            const char *detected = whisper_lang_str(whisper_full_lang_id(asr_.get()));
            if (!detected) throw std::runtime_error("Whisper could not determine a language from speech.");
            language_ = detected;
        }
        return collect(asr_.get(), start_sample, end, need_times);
    }

    void detect(Sample length, bool finish, bool previews = false) {
        if (length == 0) return;
        diagnostics_.failed = false;
        const auto frames = (length + vad_frame - 1) / vad_frame;
        if (!whisper_vad_detect_speech_no_reset(vad_.get(), audio_.data() + (scanned_ - audio_start_), static_cast<int>(length)) ||
            diagnostics_.failed || whisper_vad_n_probs(vad_.get()) != frames) {
            throw std::runtime_error("Silero VAD inference failed or the model has an incompatible frame size.");
        }
        const auto *probs = whisper_vad_probs(vad_.get());
        for (Sample i = 0; i < frames; ++i) {
            const auto available = finish ? received_ - scanned_ : vad_frame;
            const auto size = std::min<Sample>(available, vad_frame);
            if (!std::isfinite(probs[i]) || probs[i] < 0 || probs[i] > 1) {
                throw std::runtime_error("Silero returned an invalid speech probability.");
            }
            scanned_ += size;
            ++vad_frames_;
            gate(probs[i], size, previews);
        }
    }

    void gate(float probability, Sample size, bool previews) {
        if (!active_) {
            if (probability < 0.5f) {
                rising_ = 0;
                return;
            }
            rising_ += size;
            if (rising_ < onset) return;
            frontier_ = std::max({frontier_, audio_start_, scanned_ - rising_ - preroll});
            decode_from_ = frontier_;
            seam_.clear();
            draft_.clear();
            pauses_.clear();
            preview_at_ = scanned_ - rising_;
            voiced_ = rising_;
            rising_ = 0;
            quiet_since_ = -1;
            active_ = true;
        } else if (probability >= 0.35f) {
            const auto gap = scanned_ - size - quiet_since_;
            if (quiet_since_ >= 0 && gap >= 2 * vad_frame) {
                pauses_.push_back(quiet_since_ + gap / 2);
                while (pauses_.front() < scanned_ - preview_limit() - rate) pauses_.pop_front();
            }
            voiced_ += size;
            quiet_since_ = -1;
        } else {
            if (quiet_since_ < 0) quiet_since_ = scanned_ - size;
            if (scanned_ - quiet_since_ >= release) {
                finalize(quiet_since_ + tail);
                return;
            }
        }
        if (scanned_ - frontier_ >= rollover) cut_span(previews);
    }

    void trim_before(Sample position) {
        if (position <= audio_start_) return;
        audio_.erase(audio_.begin(), audio_.begin() + (position - audio_start_));
        audio_start_ = position;
    }

    void trim_idle_audio() {
        trim_before(active_ ? decode_from_ : std::max(frontier_, scanned_ - preroll - onset));
    }

    void finalize(Sample end) {
        active_ = false;
        if (end <= frontier_) return; // An empty rollover may already cover the endpoint's tail.
        const bool overlap_present = decode_from_ < frontier_;
        const auto result = decode_window(decode_from_, end, overlap_present, Decode::Endpoint);
        if (!result.placeable) throw std::runtime_error("Could not place final words after a live window boundary.");
        text_event("final", frontier_, end, overlap_present ? result.owned(seam_.first_owned(result, frontier_), end) : result.text);
        frontier_ = end;
    }

    void cut_span(bool previews) {
        const auto result = decode_window(decode_from_, scanned_, true, Decode::Rollover);
        if (!result.placeable) throw std::runtime_error("Could not place words at the live window limit.");
        // An empty window advances by exactly 20 seconds and must not leave
        // old overlap to be decoded again. This also applies while catching up.
        Sample cut = frontier_ + rollover;
        const auto first = seam_.first_owned(result, frontier_);
        bool drafted = false;
        if (first == result.pieces.size()) {
            text_event("final", frontier_, cut, "");
            decode_from_ = cut;
            seam_.clear();
        } else {
            // Leave right context for words near the cut. Prefer the closest
            // timestamp boundary to the target if a word straddles it.
            const auto target = cut - overlap;
            cut = target;
            for (const auto &piece : result.pieces) {
                if (piece.from < target && target < piece.to) {
                    cut = piece.from > target - overlap ? piece.from : piece.to;
                    break;
                }
            }
            text_event("final", frontier_, cut, result.owned(first, cut));
            decode_from_ = std::max(decode_from_, cut - overlap);
            seam_.remember(result, decode_from_, cut, scanned_);
            // The fresh rollover decode already saw the right context. In a
            // preview-enabled feed use it instead of immediately decoding it
            // twice, or leaving the new span blank until the next preview.
            if (previews && cut < scanned_) {
                const auto draft = result.owned(result.first_owned(cut), scanned_);
                if (!draft.empty()) {
                    text_event("partial", cut, scanned_, draft);
                    drafted = true;
                }
            }
        }
        frontier_ = cut;
        draft_.clear();
        preview_at_ = drafted ? scanned_ : cut;
        voiced_ = std::max<Sample>(0, (quiet_since_ < 0 ? scanned_ : quiet_since_) - cut);
        trim_before(decode_from_);
    }

    Diagnostics &diagnostics_;
    std::string language_;
    bool translate_;
    std::unique_ptr<whisper_context, decltype(&whisper_free)> asr_{nullptr, whisper_free};
    std::unique_ptr<whisper_vad_context, decltype(&whisper_vad_free)> vad_{nullptr, whisper_vad_free};
    std::vector<float> audio_;
    Seam seam_;
    DraftAgreement draft_;
    std::deque<Sample> pauses_;
    Sample audio_start_ = 0;
    Sample received_ = 0;
    Sample scanned_ = 0;
    Sample frontier_ = 0;
    Sample decode_from_ = 0;
    Sample rising_ = 0;
    Sample quiet_since_ = -1;
    Sample voiced_ = 0;
    Sample preview_at_ = 0;
    bool heavy_encoder_ = false;
    bool active_ = false;
    std::int64_t vad_frames_ = 0;
    std::int64_t asr_calls_ = 0;
    std::int64_t asr_us_ = 0;
};
} // namespace

int run_live(int argc, char **argv) {
    static Diagnostics diagnostics;
    whisper_log_set(upstream_log, &diagnostics);
    ggml_log_set(upstream_log, &diagnostics);
    try {
#ifdef _WIN32
        if (_setmode(_fileno(stdin), _O_BINARY) == -1) throw std::runtime_error("Could not set live PCM stdin to binary mode.");
#endif
        Decoder decoder(parse_options(argc, argv), diagnostics);
        decoder.run();
        return 0;
    } catch (const std::runtime_error &error) {
        try {
            emit("{\"type\":\"error\",\"message\":" + json_string(error.what()) + "}");
        } catch (...) {
            std::fputs("micme-live: could not report worker failure\n", stderr);
        }
    } catch (...) {
        std::fputs("{\"type\":\"error\",\"message\":\"Internal live decoder failure.\"}\n", stdout);
        std::fflush(stdout);
    }
    return 1;
}

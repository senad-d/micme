// Test-only Whisper/Silero adapter. Nonzero PCM opens VAD; isolated sample
// markers supply absolute word positions through the same C API as Whisper.
// The worker's framing, scheduling, windowing and output are not replaced.
#include <whisper.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

struct Word {
    std::int64_t from;
    std::int64_t to;
    const char *text;
};

struct whisper_context {
    std::string_view fixture;
    std::vector<Word> words;
    std::string text;
};

struct whisper_vad_context {
    std::vector<float> probabilities;
};

void whisper_log_set(ggml_log_callback, void *) {}
void ggml_log_set(ggml_log_callback, void *) {}

whisper_context_params whisper_context_default_params() { return {}; }
whisper_context *whisper_init_from_file_with_params(const char *model, whisper_context_params) {
    return new whisper_context{model, {}, {}};
}
void whisper_free(whisper_context *ctx) { delete ctx; }
int whisper_lang_id(const char *code) { return std::string_view(code) == "en" ? 0 : -1; }
const char *whisper_lang_str(int id) { return id == 0 ? "en" : nullptr; }
int whisper_is_multilingual(whisper_context *) { return 0; }
int whisper_model_n_audio_layer(whisper_context *) { return 12; }
int whisper_model_n_text_layer(whisper_context *) { return 12; }
int whisper_n_audio_ctx(whisper_context *) { return 1500; }

whisper_full_params whisper_full_default_params(whisper_sampling_strategy) { return {}; }
int whisper_full(whisper_context *ctx, whisper_full_params, const float *pcm, int count) {
    if (ctx->fixture == "fail-inference") return -1;
    ctx->words.clear();
    ctx->text.clear();
    for (int i = 0; i < count; ++i) {
        const int sample = static_cast<int>(pcm[i] * 32768);
        const char *word = sample == 2000 ? u8" Gr\u00fc\u00df" : sample == 3000 ? " Okay." : sample == 4000 ? " encore" : nullptr;
        if (!word) continue;
        const auto from = ctx->fixture == "untimed" ? -1 : i / 160;
        ctx->words.push_back({from, from < 0 ? -1 : from + 8, word});
        ctx->text += word;
    }
    return 0;
}
int whisper_full_lang_id(whisper_context *) { return 0; }
int whisper_full_n_segments(whisper_context *ctx) { return ctx->words.empty() ? 0 : 1; }
const char *whisper_full_get_segment_text(whisper_context *ctx, int) { return ctx->text.c_str(); }
int64_t whisper_full_get_segment_t0(whisper_context *ctx, int) { return ctx->words.front().from; }
int64_t whisper_full_get_segment_t1(whisper_context *ctx, int) { return ctx->words.back().to; }
int whisper_full_n_tokens(whisper_context *ctx, int) { return static_cast<int>(ctx->words.size()); }
whisper_token whisper_token_eot(whisper_context *) { return 100; }
const char *whisper_full_get_token_text(whisper_context *ctx, int, int index) { return ctx->words[index].text; }
whisper_token_data whisper_full_get_token_data(whisper_context *ctx, int, int index) {
    whisper_token_data token{};
    token.t0 = ctx->words[index].from;
    token.t1 = ctx->words[index].to;
    return token;
}

whisper_vad_context_params whisper_vad_default_context_params() { return {}; }
whisper_vad_context *whisper_vad_init_from_file_with_params(const char *, whisper_vad_context_params) { return new whisper_vad_context; }
void whisper_vad_free(whisper_vad_context *ctx) { delete ctx; }
void whisper_vad_reset_state(whisper_vad_context *) {}
bool whisper_vad_detect_speech_no_reset(whisper_vad_context *ctx, const float *pcm, int count) {
    ctx->probabilities.clear();
    for (int offset = 0; offset < count; offset += 512) {
        const bool voiced = std::any_of(pcm + offset, pcm + std::min(offset + 512, count), [](float sample) { return sample != 0; });
        ctx->probabilities.push_back(voiced ? 0.9f : 0.0f);
    }
    return true;
}
int whisper_vad_n_probs(whisper_vad_context *ctx) { return static_cast<int>(ctx->probabilities.size()); }
float *whisper_vad_probs(whisper_vad_context *ctx) { return ctx->probabilities.data(); }

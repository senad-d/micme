#include <transcribe.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <csignal>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

namespace {
constexpr uint32_t sample_rate = 16000;
constexpr uint32_t max_samples = 120 * sample_rate;
constexpr uint32_t max_reply = 256 * 1024;
constexpr uint32_t max_request = 2 * max_samples + 8192;
uint64_t asr_calls = 0;

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void check(transcribe_status status, const char *message) {
    require(status == TRANSCRIBE_OK, message);
}

std::string_view view(const char *text) { return text ? text : ""; }
const char *flag(bool value) { return value ? "true" : "false"; }

std::string json(std::string_view text) {
    require(text.size() <= max_reply / 2, "Native text exceeds the reply limit.");
    constexpr char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (unsigned char ch : text) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += static_cast<char>(ch); }
        else if (ch < 32) { result += "\\u00"; result += hex[ch >> 4]; result += hex[ch & 15]; }
        else result += static_cast<char>(ch);
    }
    return result + '"';
}

uint32_t u32(const uint8_t *bytes) {
    return (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) |
           (uint32_t(bytes[2]) << 8) | uint32_t(bytes[3]);
}

class Request {
    const std::vector<uint8_t> &bytes;
    size_t cursor = 1;
public:
    explicit Request(const std::vector<uint8_t> &frame) : bytes(frame) {}
    uint8_t op() const { return bytes[0]; }
    size_t left() const { return bytes.size() - cursor; }
    uint32_t number() {
        require(left() >= 4, "Incomplete native request.");
        const auto value = u32(bytes.data() + cursor);
        cursor += 4;
        return value;
    }
    std::string text(size_t limit) {
        const size_t size = number();
        require(size <= left() && size <= limit, "Invalid native request string.");
        std::string result(reinterpret_cast<const char *>(bytes.data() + cursor), size);
        require(result.find('\0') == std::string::npos, "Invalid native request string.");
        cursor += size;
        return result;
    }
    void end() const { require(left() == 0, "Unexpected native request bytes."); }
    std::vector<float> pcm(size_t prefix = 0) {
        require(left() % 2 == 0 && prefix + left() / 2 <= max_samples, "Invalid or too large native PCM block.");
        std::vector<float> result(prefix + left() / 2);
        for (size_t i = prefix; i < result.size(); ++i) {
            const int value = bytes[cursor] | (int(bytes[cursor + 1]) << 8);
            result[i] = (value < 32768 ? value : value - 65536) / 32768.0f;
            cursor += 2;
        }
        return result;
    }
    bool digitalZero() const {
        return std::all_of(bytes.begin() + cursor, bytes.end(), [](uint8_t byte) { return byte == 0; });
    }
};

transcribe_device_info device_info(transcribe_device_t device) {
    transcribe_device_info info;
    transcribe_device_info_init(&info);
    check(transcribe_device_get_info(device, &info), "Cannot query the native device.");
    return info;
}

std::string identity(const transcribe_device_info &info) {
    const auto id = view(info.device_id);
    const auto label = view(info.description).empty() ? view(info.name) : view(info.description);
    if (id.empty() && label.empty()) return "null";
    return "{\"id\":" + (id.empty() ? "null" : json(id)) + ",\"label\":" + (label.empty() ? "null" : json(label)) + '}';
}

std::string_view compute(std::string_view name) {
    if (name == "cpu" || name == "metal" || name == "vulkan") return name;
    return "unknown";
}

std::string devices() {
    std::string result = "[";
    for (int i = 0; i < transcribe_device_count(); ++i) {
        const auto info = device_info(transcribe_device_get(i));
        const auto backend = compute(view(info.kind));
        if (backend == "unknown") continue;
        if (result.size() > 1) result += ',';
        result += "{\"backend\":" + json(backend) + ",\"device\":" + identity(info) + '}';
    }
    // A backend-only probe is never a physical identity.
    if (result.size() == 1 && transcribe_backend_available(TRANSCRIBE_BACKEND_CPU))
        result += "{\"backend\":\"cpu\",\"device\":null}";
    return "{\"devices\":" + result + "]}";
}

std::string language_list(const transcribe_capabilities &caps) {
    std::string result = "[";
    for (int i = 0; i < caps.n_languages; ++i) {
        if (i) result += ',';
        result += json(view(caps.languages[i]));
    }
    return result + ']';
}

std::string result_text(transcribe_session *session) {
    // Engine text before any Micme finishing; not the diagnostic special-token view.
    return json(view(transcribe_full_text(session)));
}

std::string sample_reply(const char *kind, uint32_t count, std::string text, bool changed) {
    return "{\"kind\":\"" + std::string(kind) + "\",\"through\":" + std::to_string(count) +
           ",\"text\":" + text + ",\"changed\":" + flag(changed) + '}';
}

class Recognizer {
    std::unique_ptr<transcribe_model, decltype(&transcribe_model_free)> model{nullptr, transcribe_model_free};
    std::unique_ptr<transcribe_session, decltype(&transcribe_session_free)> session{nullptr, transcribe_session_free};
    transcribe_capabilities caps{};
    int threads = 4;
    unsigned asr_loads = 0;
    bool active = false;
    uint32_t through = 0;
    uint32_t deferred_zeros = 0;
    bool fed_speech = false;

    std::string load(Request &request) {
        require(!model, "The recognizer already holds a model.");
        const auto backend = request.text(16);
        const auto device = request.text(256);
        const auto n = request.number();
        request.end();
        require(n > 0 && n <= 32, "Invalid native thread count.");
        threads = static_cast<int>(n);
        require(backend == "auto" || backend == "cpu", "This recognizer build supports CPU only.");
        transcribe_model_load_params config;
        transcribe_model_load_params_init(&config);
        config.backend = TRANSCRIBE_BACKEND_CPU;
        config.no_mmap = true;
        if (!device.empty()) {
            for (int i = 0; i < transcribe_device_count(); ++i) {
                const auto candidate = transcribe_device_get(i);
                const auto info = device_info(candidate);
                if (view(info.kind) != "cpu" || view(info.device_id) != device) continue;
                require(!config.device, "The requested native device ID is ambiguous.");
                config.device = candidate;
            }
            require(config.device, "The requested native device is unavailable.");
        }
        transcribe_model *loaded = nullptr;
        // The launcher verified and passed the held model, never a mutable pathname.
        check(transcribe_model_load_file("/proc/self/fd/3", &config, &loaded), "Native model load failed.");
        model.reset(loaded);
        close(3); // The loader read into owned memory; nothing refers to this descriptor now.
        ++asr_loads;
        transcribe_capabilities_init(&caps);
        check(transcribe_model_get_capabilities(model.get(), &caps), "The loaded model does not expose ASR capabilities.");
        require(caps.native_sample_rate == sample_rate, "The native model does not accept 16 kHz PCM.");
        const auto arch = view(transcribe_model_arch_string(model.get()));
        require((arch == "moonshine_streaming" && caps.supports_streaming) || (arch == "parakeet" && !caps.supports_streaming),
                "The loaded native model has no instrumented adapter for this route.");
        new_session();
        std::string_view actual = compute(view(transcribe_model_backend(model.get())));
        std::string bound = "null";
        if (const auto handle = transcribe_model_device(model.get())) {
            const auto info = device_info(handle);
            actual = compute(view(info.kind));
            bound = identity(info);
        }
        return "{\"arch\":" + json(arch) + ",\"threads\":" + std::to_string(threads) +
            ",\"maxInputSamples\":" + std::to_string(max_input_samples()) +
            ",\"traits\":{\"stream\":" + flag(caps.supports_streaming) +
            ",\"batch\":true,\"longForm\":" + flag(transcribe_model_supports(model.get(), TRANSCRIBE_FEATURE_LONG_FORM)) +
            ",\"nativeLid\":" + flag(caps.supports_language_detect) +
            // Neither initial route exposes bias, translation, or a native speech endpoint.
            ",\"bias\":false,\"translateEn\":false,\"vad\":\"off\",\"languages\":" + language_list(caps) +
            ",\"actualCompute\":" + json(actual) + ",\"boundDevice\":" + bound + "}}";
    }

    void new_session() {
        session.reset();
        transcribe_session_params config;
        transcribe_session_params_init(&config);
        config.n_threads = threads;
        transcribe_session *fresh = nullptr;
        check(transcribe_session_init(model.get(), &config, &fresh), "Native session initialization failed.");
        session.reset(fresh);
        active = false;
        through = deferred_zeros = 0;
        fed_speech = false;
    }

    transcribe_run_params run_params(const std::string &language) const {
        bool accepted = language == "auto" && (caps.supports_language_detect || caps.n_languages == 1);
        for (int i = 0; i < caps.n_languages; ++i) accepted |= language == view(caps.languages[i]);
        require(accepted, "The native model does not support the selected language.");
        transcribe_run_params options;
        transcribe_run_params_init(&options);
        options.language = language != "auto" ? language.c_str() : caps.n_languages == 1 ? caps.languages[0] : nullptr;
        options.timestamps = TRANSCRIBE_TIMESTAMPS_NONE;
        return options;
    }

    std::string begin(Request &request) {
        require(caps.supports_streaming && !active, "Cannot begin this native stream.");
        const auto language = request.text(64);
        request.end();
        const auto options = run_params(language);
        transcribe_stream_params stream;
        transcribe_stream_params_init(&stream);
        // Pre-stop text is revisable. Do not mistake stability heuristics for irreversible endpoints.
        stream.commit_policy = TRANSCRIBE_STREAM_COMMIT_ON_FINALIZE;
        check(transcribe_stream_begin(session.get(), &options, &stream), "Native stream initialization failed.");
        active = true;
        through = deferred_zeros = 0;
        fed_speech = false;
        return "{}";
    }

    size_t max_input_samples() const {
        if (caps.max_audio_ms <= 0 || caps.max_audio_ms >= max_samples / (sample_rate / 1000)) return max_samples;
        return static_cast<size_t>(caps.max_audio_ms) * (sample_rate / 1000);
    }

    void limit(size_t count) const {
        require(count <= max_input_samples(), "PCM exceeds the loaded native model's bounded audio limit.");
    }

    std::string feed(Request &request) {
        require(active, "No active native stream.");
        const auto from = request.number();
        require(from == through && request.left() > 0 && request.left() % 2 == 0, "Non-contiguous or invalid native stream PCM.");
        const auto count = request.left() / 2;
        limit(through + count);
        bool changed = false;
        if (!fed_speech && request.digitalZero()) {
            // Defer only an exact digital-zero prefix. Flush every sample with the
            // first nonzero block; an all-zero take never enters the ASR decoder.
            deferred_zeros += static_cast<uint32_t>(count);
        } else {
            const auto pcm = request.pcm(deferred_zeros);
            transcribe_stream_update update;
            transcribe_stream_update_init(&update);
            check(transcribe_stream_feed(session.get(), pcm.data(), static_cast<int>(pcm.size()), &update), "Native stream feed failed.");
            changed = update.tentative_changed;
            deferred_zeros = 0;
            fed_speech = true;
        }
        through += static_cast<uint32_t>(count);
        return sample_reply("ack", through, changed ? result_text(session.get()) : "\"\"", changed);
    }

    std::string finish(Request &request) {
        require(active && request.number() == through, "Incorrect native stream final count.");
        request.end();
        check(transcribe_stream_finalize(session.get(), nullptr), "Native stream finalization failed.");
        require(!transcribe_was_truncated(session.get()), "The native stream result was truncated.");
        active = false;
        return sample_reply("done", through, result_text(session.get()), true);
    }

    std::string batch(Request &request) {
        require(!active, "Cannot batch while a native stream is active.");
        const auto language = request.text(64);
        const auto options = run_params(language);
        require(request.left() % 2 == 0, "Invalid native batch PCM.");
        const auto count = static_cast<uint32_t>(request.left() / 2);
        limit(count);
        if (request.digitalZero()) return sample_reply("batch", count, "\"\"", true);
        const auto pcm = request.pcm();
        check(transcribe_run(session.get(), pcm.data(), static_cast<int>(pcm.size()), &options), "Native batch inference failed.");
        require(!transcribe_was_truncated(session.get()), "The native batch result was truncated.");
        return sample_reply("batch", count, result_text(session.get()), true);
    }

public:
    std::string execute(Request &request) {
        if (request.op() == 'V') { request.end(); return devices(); }
        if (request.op() == 'L') return load(request);
        if (request.op() == 'Q') { request.end(); session.reset(); model.reset(); return "{}"; }
        require(session.get(), "No native model is loaded.");
        switch (request.op()) {
            case 'B': return begin(request);
            case 'F': return feed(request);
            case 'D': return finish(request);
            case 'T': return batch(request);
            case 'R': request.end(); new_session(); return "{}";
            default: throw std::runtime_error("Unknown native recognizer request.");
        }
    }

    std::string counters() const {
        struct rusage resource{};
        const auto peak = getrusage(RUSAGE_SELF, &resource) == 0 ? std::to_string(uint64_t(resource.ru_maxrss) * 1024) : "null";
        return ",\"asrCalls\":" + std::to_string(asr_calls) + ",\"asrLoads\":" + std::to_string(asr_loads) +
               ",\"vadLoads\":0,\"peakRssBytes\":" + peak;
    }
};

bool send(FILE *out, const std::string &body) {
    if (body.size() > max_reply) return false;
    const auto size = static_cast<uint32_t>(body.size());
    const uint8_t header[] = {uint8_t(size >> 24), uint8_t(size >> 16), uint8_t(size >> 8), uint8_t(size)};
    return std::fwrite(header, 1, sizeof(header), out) == sizeof(header) &&
           std::fwrite(body.data(), 1, body.size(), out) == body.size() && std::fflush(out) == 0;
}

int serve(FILE *out) {
    transcribe_backend_init_params params;
    transcribe_backend_init_params_init(&params);
    params.allowed_backends = TRANSCRIBE_BACKEND_MASK_CPU;
    if (transcribe_init_backends_ex(&params) != TRANSCRIBE_OK) return 1;
    Recognizer engine;
    for (;;) {
        uint8_t header[4];
        const auto bytes = std::fread(header, 1, sizeof(header), stdin);
        if (bytes == 0 && std::feof(stdin)) return 0;
        if (bytes != sizeof(header)) return 1;
        const auto size = u32(header);
        if (size == 0 || size > max_request) return 1;
        std::vector<uint8_t> frame(size);
        if (std::fread(frame.data(), 1, size, stdin) != size) return 1;
        Request request(frame);
        try {
            const auto data = engine.execute(request);
            if (!send(out, "{\"version\":1,\"ok\":true,\"data\":" + data + engine.counters() + '}')) return 1;
        } catch (const std::runtime_error &error) {
            send(out, "{\"version\":1,\"ok\":false,\"error\":" + json(error.what()) + engine.counters() + '}');
            return 1;
        }
        if (request.op() == 'Q') return 0;
    }
}
} // namespace

extern "C" void micme_asr_call() { ++asr_calls; }

int main(int argc, char **argv) {
    if (argc != 2 || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || std::to_string(getppid()) != argv[1]) return 1;
    close(4); // The executable was selected by this inherited descriptor.
    const int pipe = dup(STDOUT_FILENO);
    if (pipe == -1 || dup2(STDERR_FILENO, STDOUT_FILENO) == -1) return 1;
    auto *out = fdopen(pipe, "wb");
    if (!out) return 1;
    const int result = serve(out);
    return std::fclose(out) == 0 ? result : 1;
}

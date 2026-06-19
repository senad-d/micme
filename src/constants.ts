export const STATUS_KEY = "micme";
export const RECORDING_WIDGET_KEY = "micme-recording";
export const DEFAULT_SHORTCUT = "alt+m";
export const DEFAULT_MACOS_PRINTABLE_SHORTCUT = "§";
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120_000;
export const DEFAULT_RECORD_SAMPLE_RATE = 48_000;
export const DEFAULT_TRANSCRIBE_SAMPLE_RATE = 16_000;
export const RECORDER_STARTUP_GRACE_MS = 700;
export const RECORDER_STOP_GRACE_MS = 3_000;
export const MIN_AUDIO_BYTES = 512;
export const MAX_CAPTURED_OUTPUT_CHARS = 100_000;
export const STREAM_MIN_INITIAL_WORDS = 1;
export const DEFAULT_STREAM_STEP_MS = 1_000;
export const DEFAULT_STREAM_LENGTH_MS = 5_000;
export const DEFAULT_STREAM_KEEP_MS = 500;
export const DEFAULT_STREAM_MAX_TOKENS = 64;
export const DEFAULT_STREAM_VAD_THRESHOLD = 0.45;
export const DEFAULT_STREAM_FLUSH_MS = 700;
export const STREAM_PROFILE_STEP_MS = 500;
export const STREAM_PROFILE_LENGTH_MS = 3_000;
export const STREAM_PROFILE_KEEP_MS = 300;
export const STREAM_PROFILE_MAX_TOKENS = 32;
export const STREAM_PROFILE_WORDS_PER_CHUNK = 5;
export const STREAM_PROFILE_VAD_THRESHOLD = 0.35;
export const STREAM_PROFILE_FLUSH_MS = 650;
export const DEFAULT_MIN_MAX_VOLUME_DB = -50;
export const AUDIO_VALIDATION_TIMEOUT_MS = 30_000;
export const DEFAULT_WHISPER_CPP_MODEL_NAME = "small.en";
export const WHISPER_CPP_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
export const WHISPER_CPP_MODEL_NAMES = [
	"tiny.en",
	"tiny",
	"base.en",
	"base",
	"small.en",
	"small",
	"medium.en",
	"medium",
	"large-v1",
	"large-v2",
	"large-v3",
	"large-v3-turbo",
] as const;
export const PYTHON_WHISPER_MODEL_NAMES = ["tiny.en", "tiny", "base.en", "base", "small.en", "small", "medium.en", "medium", "large-v1", "large-v2", "large-v3", "large"] as const;


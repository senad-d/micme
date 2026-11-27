import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RecordingDirectory } from "./recording-dir.ts";
import type { Capture } from "./transfer/contracts.ts";

export type TranscriptionMode = "clip" | "stream";
export type TranscribeBackend = "auto" | "whisper.cpp" | "python" | "custom";
export type EffectiveBackend = "whisper.cpp" | "python" | "custom" | "none";
export type WhisperCppModelSource = "explicit-path" | "configured-name" | "default-name";
export type TranscriptionModelSource = WhisperCppModelSource | "python-name" | "custom-command";

export type ResolvedWhisperCppModel = {
	path: string;
	modelName?: string;
	source: WhisperCppModelSource;
	configuredValue?: string;
	exists: boolean;
	downloadable: boolean;
	translationFallbackFrom?: string;
};

export type ResolvedTranscriptionPlan = {
	requestedBackend: TranscribeBackend;
	effectiveBackend: EffectiveBackend;
	reason: string;
	command?: string;
	binary?: string;
	modelName?: string;
	modelPath?: string;
	modelSource?: TranscriptionModelSource;
	modelDownloadable?: boolean;
	live?: LivePlan;
	warnings: string[];
};

export type LivePlan = {
	binary: string;
	modelPath: string;
	vadModelPath: string;
	language: string;
	translate: boolean;
	finalizeWithClip: boolean;
};

export type CommandSpec = {
	command: string;
	args: string[];
	display: string;
	spawnOptions?: Pick<SpawnOptions, "env" | "windowsVerbatimArguments">;
	meterFromStdout?: boolean;
	/** The selected recorder and its requested route, not evidence of a bound device. */
	capture?: Pick<Capture, "source" | "requested">;
	/** A legacy clip hook in a temporary directory keeps the caller's working directory. */
	useCallerCwd?: true;
	stopInput?: string;
	signalStopExitCodes?: number[];
};

export type RunResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stdoutTruncated: boolean;
	stderr: string;
	timedOut: boolean;
	cancelled?: boolean;
};

export type ExitResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
};

export type AudioDiagnostics = {
	meanVolumeDb?: number;
	maxVolumeDb: number;
	raw: string;
};

export type AudioValidationOutcome =
	| { status: "validated"; diagnostics: AudioDiagnostics }
	| { status: "skipped"; reason: "disabled" | "ffmpeg-unavailable" };

export type OwnedProcess = {
	process: ChildProcess;
	command: CommandSpec;
	stopRequested?: boolean;
	stopSignals?: Set<NodeJS.Signals>;
	windowsTreeStopped?: boolean;
	stopPromise?: Promise<ExitResult>;
	exitObserved: Promise<ExitResult>;
	exitPromise: Promise<ExitResult>;
	getExit: () => ExitResult;
	isSettled: () => boolean;
	stderr: () => string;
};

export type Recording = OwnedProcess & {
	audioPath: string;
	tempDir: string;
	directory?: RecordingDirectory;
	startedAt: number;
	startedAtMonotonic: number;
	audioLevel: () => number;
	/** The meter is authoritative even at zero; never reopen the spool for a fallback. */
	livePcmMeter?: true;
	liveDraft?: string;
	stdout: () => string;
};

export type MicmeConfigState = {
	path: string;
	values: Record<string, string>;
	error?: string;
};

export type ModelCandidate = {
	label: string;
	value: string;
	description: string;
	installed: boolean;
	kind?: "model-name" | "path";
};

export type AudioDeviceCandidate = {
	label: string;
	value: string;
	description: string;
};


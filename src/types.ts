import type { ChildProcess } from "node:child_process";

export type TranscriptionMode = "clip" | "stream";

export type CommandSpec = {
	command: string;
	args: string[];
	display: string;
	meterFromStdout?: boolean;
	stopInput?: string;
};

export type RunResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

export type ExitResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
};

export type AudioDiagnostics = {
	meanVolumeDb?: number;
	maxVolumeDb?: number;
	raw: string;
};

export type StreamingState = {
	baseText: string;
	previewText: string;
	outputBuffer: string;
	lastText: string;
	pendingWords: string[];
	emittedWords: string[];
	startedAt: number;
	firstOutputAt?: number;
	firstPreviewAt?: number;
	flushTimer?: ReturnType<typeof setTimeout>;
};

export type Recording = {
	process: ChildProcess;
	audioPath: string;
	tempDir: string;
	startedAt: number;
	command: CommandSpec;
	audioLevel: () => number;
	streaming?: StreamingState;
	clipRecording?: Recording;
	stopRequested?: boolean;
	exitPromise: Promise<ExitResult>;
	isSettled: () => boolean;
	stdout: () => string;
	stderr: () => string;
};

export type DotEnvState = {
	path: string;
	values: Record<string, string>;
	error?: string;
};

export type ModelCandidate = {
	label: string;
	value: string;
	description: string;
	installed: boolean;
};

export type AudioDeviceCandidate = {
	label: string;
	value: string;
	description: string;
};


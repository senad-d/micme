export function stripTerminalControlSequences(value: string) {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/\x1b[ -/]*[@-~]/g, " ")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
}

export function sanitizeTerminalText(value: string) {
	return stripTerminalControlSequences(value).replace(/\s+/g, " ").trim();
}

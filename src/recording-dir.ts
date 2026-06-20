import { lstat, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_RECORDINGS_DIR = "micme-rec";
const RECORDING_DIR_PREFIX = "rec-";
const MAX_SEQUENTIAL_RECORDING_DIRS = 999_999;

export async function createRecordingDirectory(cwd: string, keepAudio: boolean, tempPrefix = "micme-") {
	if (!keepAudio) return mkdtemp(join(tmpdir(), tempPrefix));
	return createProjectRecordingDirectory(cwd);
}

export async function createProjectRecordingDirectory(cwd: string) {
	const recordingsRoot = join(cwd, PROJECT_RECORDINGS_DIR);
	await mkdir(recordingsRoot, { recursive: true });
	await assertSafeRecordingsRoot(recordingsRoot);

	const nextIndex = await getNextRecordingIndex(recordingsRoot);

	for (let index = nextIndex; index <= MAX_SEQUENTIAL_RECORDING_DIRS; index += 1) {
		const candidate = join(recordingsRoot, formatRecordingDirectoryName(index));
		try {
			await mkdir(candidate);
			return candidate;
		} catch (error) {
			if (isAlreadyExistsError(error)) continue;
			throw error;
		}
	}

	throw new Error(`Unable to create a Micme recording directory under ${recordingsRoot}.`);
}

async function assertSafeRecordingsRoot(recordingsRoot: string) {
	const stats = await lstat(recordingsRoot);
	if (stats.isSymbolicLink()) {
		throw new Error(`Refusing to keep Micme audio in a symbolic-link recordings directory: ${recordingsRoot}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Micme recordings path is not a directory: ${recordingsRoot}`);
	}
}

async function getNextRecordingIndex(recordingsRoot: string) {
	const entries = await readdir(recordingsRoot, { withFileTypes: true });
	let maxIndex = 0;
	for (const entry of entries) {
		const match = /^rec-(\d+)$/.exec(entry.name);
		if (!match) continue;
		const index = Number(match[1]);
		if (Number.isInteger(index) && index > maxIndex) maxIndex = index;
	}
	return Math.max(1, maxIndex + 1);
}

export function formatRecordingDirectoryName(index: number) {
	const safeIndex = Math.max(1, Math.trunc(index));
	const text = String(safeIndex);
	return `${RECORDING_DIR_PREFIX}${text.padStart(Math.max(3, text.length), "0")}`;
}

function isAlreadyExistsError(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

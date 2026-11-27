import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, read, realpathSync, write, type BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { validateCompletedClipWav, WavHeaderScanner } from "../audio-level.ts";
import { getMicmeAgentDir, getTransferOptions } from "../config.ts";
import { LIVE_CAPTURE_RATE } from "../constants.ts";
import { hasExtendedPosixAcl, posixFileIdentity, PosixDirectory } from "../posix-directory.ts";
import { findExecutable, runProcess } from "../processes.ts";
import { createLiveRecordingDirectory, type RecordingDirectory, type VerifiedRecordingFile } from "../recording-dir.ts";
import { bindSnapshotSource, hashRecordingBytes, snapshotVerifiedAudio } from "./capture.ts";
import {
	LIBRARY_PAGE_SIZE, LIBRARY_SCHEMA_VERSION,
	type DeleteRow, type EnqueueImport, type EntryId, type Page, type Play, type PublishAudio, type ReadVerifiedAudio,
	type RecognizeFile, type Retry, type Row, type SaveTake, type Signal, type Star, type UpdateTake, type VerifiedAudio,
} from "./contracts.ts";
import { enforceRetention, retentionIds } from "./retention.ts";

const STORE_NAME = "micme-library";
const INDEX_NAME = "history.sqlite3";
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const READ_LEAF = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_LEAF = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const COPY_BLOCK_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const readAt = promisify(read);
const writeAt = promisify(write);
const STORE_DISABLED = "Micme local history is disabled.";
const NO_INDEX = "Micme's local history index is missing.";
const UNSAFE_STORE = "Micme could not establish a private local history store.";
const NO_AUDIO = "Micme no longer has verified audio for this take.";
const NEVER_ABORTED = new AbortController().signal;
const activeRetries = new Set<string>();
const TAKE_FIELDS = `id, created_utc AS createdUtc, source, filename, language, raw, local, polished, model_id AS modelId, starred, state,
	done_samples AS doneSamples, total_samples AS totalSamples, wav_bytes AS bytes, wav_sha AS sha256, wav_identity AS identity,
	wav_stamp AS stamp, deleting, job_token AS jobToken, job_pid AS jobPid, job_prior_state AS jobPriorState`;
const CHANGE_COLUMNS = { polished: "polished", raw: "raw", local: "local", state: "state", language: "language", modelId: "model_id",
	doneSamples: "done_samples", totalSamples: "total_samples" } as const;

const SCHEMA = `
	CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
	INSERT INTO metadata VALUES ('retention', 'never'), ('generation', '0');
	CREATE TABLE takes (
		id TEXT PRIMARY KEY, created_utc TEXT NOT NULL, source TEXT NOT NULL,
		filename TEXT, language TEXT, raw TEXT, local TEXT, polished TEXT, model_id TEXT,
		starred INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, done_samples INTEGER NOT NULL DEFAULT 0, total_samples INTEGER,
		wav_bytes INTEGER, wav_sha TEXT, wav_identity TEXT, wav_stamp TEXT,
		deleting INTEGER NOT NULL DEFAULT 0, job_choice TEXT, job_pid INTEGER, job_token TEXT, job_prior_state TEXT
	) STRICT;
	CREATE INDEX take_order ON takes (created_utc DESC, id DESC);
	CREATE INDEX retention_order ON takes (created_utc DESC, id DESC) WHERE starred = 0 AND source <> 'import' AND deleting = 0;
	CREATE INDEX deleting_takes ON takes (id) WHERE deleting = 1;
	CREATE INDEX active_jobs ON takes (job_pid) WHERE job_pid IS NOT NULL;
	CREATE TABLE installing (id TEXT PRIMARY KEY, identity TEXT NOT NULL) STRICT;
	PRAGMA user_version = ${LIBRARY_SCHEMA_VERSION};`;

type StoredTake = Omit<Row, "wav" | "starred"> & {
	starred: 0 | 1; bytes: number | null; sha256: string | null; identity: string | null; stamp: string | null;
	deleting: 0 | 1; jobToken: string | null; jobPid: number | null; jobPriorState: Row["state"] | null;
};
type FileReceipt = Pick<VerifiedAudio, "bytes" | "sha256"> & { identity: string; stamp: string };

type FileSource = { file: VerifiedRecordingFile; bytes: number; check: () => void };
type StagedInput = FileSource & { release: () => Promise<void> };
class UnverifiedWav extends Error {
	constructor() { super(NO_AUDIO); }
}

function errorCode(error: unknown, code: string) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function requireId(id: EntryId) {
	if (!UUID.test(id)) throw new Error("Micme requires a valid history entry ID.");
	return id;
}

function leafName(id: EntryId, suffix = ".wav") {
	return requireId(id) + suffix;
}

function ownedIdentity(stats: BigIntStats) {
	return `${posixFileIdentity(stats)}:${stats.birthtimeNs}`;
}

function contentStamp(stats: BigIntStats) { return `${stats.size}:${stats.mtimeNs}`; }

function fileStamp(stats: BigIntStats) { return `${contentStamp(stats)}:${stats.ctimeNs}`; }

function isPrivateFile(stats: BigIntStats, fd: number) {
	return stats.isFile() && stats.uid === BigInt(process.geteuid!()) && stats.nlink === 1n && stats.birthtimeNs > 0n &&
		(stats.mode & 0o7777n) === BigInt(PRIVATE_FILE) && !hasExtendedPosixAcl(fd);
}

function checkPrivateDirectory(directory: PosixDirectory, privateMode: boolean) {
	const stats = fstatSync(directory.fd, { bigint: true });
	const mask = privateMode ? 0o7777n : 0o022n;
	if (stats.uid !== BigInt(process.geteuid!()) || (stats.mode & mask) !== (privateMode ? BigInt(PRIVATE_DIR) : 0n) ||
		hasExtendedPosixAcl(directory.fd)) throw new Error(UNSAFE_STORE);
}

function optionalLeaf(directory: PosixDirectory, name: string, flags = READ_LEAF) {
	try { return directory.openFile(name, flags); }
	catch (error) { if (errorCode(error, "ENOENT")) return undefined; throw error; }
}

function privateEntry(directory: PosixDirectory, name: string) {
	let fd: number | undefined;
	try {
		fd = optionalLeaf(directory, name);
		if (fd === undefined) return undefined;
		const stats = fstatSync(fd, { bigint: true });
		if (!isPrivateFile(stats, fd)) throw new UnverifiedWav();
		return stats;
	} catch (error) {
		if (errorCode(error, "ELOOP")) throw new UnverifiedWav();
		throw error;
	} finally { if (fd !== undefined) closeSync(fd); }
}

function openLibraryRoot(agentDir: string, create: boolean) {
	if (!(process.platform === "linux" || process.platform === "darwin")) {
		throw new Error("Micme local history requires a host with verified private directory access.");
	}
	if (create && !lstatSync(agentDir, { throwIfNoEntry: false })) mkdirSync(agentDir, { mode: PRIVATE_DIR, recursive: true });
	let parent: PosixDirectory;
	try { parent = PosixDirectory.openProject(realpathSync(dirname(agentDir))); }
	catch (error) { if (errorCode(error, "ENOENT") && !create) return undefined; throw error; }
	let agent: PosixDirectory | undefined;
	try {
		agent = parent.openDirectory(basename(agentDir));
		checkPrivateDirectory(agent, false);
		if (create) {
			try { agent.mkdir(STORE_NAME, PRIVATE_DIR); }
			catch (error) { if (!errorCode(error, "EEXIST")) throw error; }
		}
		const root = agent.openDirectory(STORE_NAME);
		try {
			checkPrivateDirectory(root, true);
			return root;
		} catch (error) { root.close(); throw error; }
	} catch (error) {
		if (!create && errorCode(error, "ENOENT")) return undefined;
		throw new Error(UNSAFE_STORE, { cause: error });
	} finally { agent?.close(); parent.close(); }
}

async function lockLibrary(root: PosixDirectory, signal: Signal) {
	const deadline = performance.now() + LOCK_WAIT_MS;
	while (!root.tryLockExclusive()) {
		if (performance.now() >= deadline) throw new Error("Micme local history is busy; try again.");
		await delay(20, undefined, { signal });
	}
	signal.throwIfAborted();
}

function initialize(db: DatabaseSync) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	if (version !== 0 && version !== LIBRARY_SCHEMA_VERSION) throw new Error("Micme does not support this local history index version.");
	if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error(UNSAFE_STORE);
	db.exec("PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON; PRAGMA synchronous = EXTRA");
	if (version === 0) {
		if (db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()) throw new Error(UNSAFE_STORE);
		transaction(db, () => db.exec(SCHEMA));
	}
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = run();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* SQLite may have rolled back after an I/O error. */ }
		throw error;
	}
}

/** A scope holds the directory and cross-process lock across all related DB/file changes. */
export async function withLibrary<T>(mode: "read" | "existing" | "create", signal: Signal, run: (store: LibraryStore) => T | Promise<T>): Promise<T | undefined> {
	signal.throwIfAborted();
	if (!getTransferOptions().MICME_HISTORY) {
		if (mode === "create") throw new Error(STORE_DISABLED);
		return undefined;
	}
	const agentDir = getMicmeAgentDir();
	const root = openLibraryRoot(agentDir, mode === "create");
	if (!root) return undefined;
	let db: DatabaseSync | undefined;
	const path = join(agentDir, STORE_NAME);
	try {
		await lockLibrary(root, signal);
		if (!getTransferOptions().MICME_HISTORY) {
			if (mode === "create") throw new Error(STORE_DISABLED);
			return undefined;
		}
		const { DatabaseSync } = await import("node:sqlite");
		signal.throwIfAborted();
		if (!root.isAt(path)) throw new Error(UNSAFE_STORE);
		checkPrivateDirectory(root, true);
		let index = privateEntry(root, INDEX_NAME);
		if (!index && mode !== "create") return undefined;
		if (!index) {
			const fd = root.openFile(INDEX_NAME, CREATE_LEAF, PRIVATE_FILE);
			try { index = fstatSync(fd, { bigint: true }); }
			finally { closeSync(fd); }
		}
		// SQLite opens its journals by name. Only use rollback journaling under the
		// held private root, never follow sidecar links or allow WAL/SHM redirection.
		privateEntry(root, `${INDEX_NAME}-journal`);
		if (privateEntry(root, `${INDEX_NAME}-wal`) || privateEntry(root, `${INDEX_NAME}-shm`)) throw new Error(UNSAFE_STORE);
		db = new DatabaseSync(join(root.procPath ?? path, INDEX_NAME));
		const store = new LibraryStore(root, path, db, ownedIdentity(index));
		store.check();
		initialize(db);
		store.recoverInstalls(mode === "read");
		store.finishDeletes(mode === "read");
		store.interruptDeadJobs();
		return await run(store);
	} finally { try { db?.close(); } finally { root.close(); } }
}

export class LibraryStore {
	private readonly root: PosixDirectory;
	private readonly path: string;
	readonly db: DatabaseSync;
	readonly identity: string;

	constructor(root: PosixDirectory, path: string, db: DatabaseSync, identity: string) {
		this.root = root;
		this.path = path;
		this.db = db;
		this.identity = identity;
	}

	check() {
		if (!this.root.isAt(this.path)) throw new Error(UNSAFE_STORE);
		checkPrivateDirectory(this.root, true);
		const index = privateEntry(this.root, INDEX_NAME);
		if (!index || ownedIdentity(index) !== this.identity) throw new Error(UNSAFE_STORE);
	}

	commit<T>(run: () => T) {
		this.check();
		privateEntry(this.root, `${INDEX_NAME}-journal`);
		return transaction(this.db, run);
	}

	get(id: EntryId) {
		return this.db.prepare(`SELECT ${TAKE_FIELDS} FROM takes WHERE id = ?`).get(requireId(id)) as StoredTake | undefined;
	}

	policy() { return this.metadata("retention"); }
	generation() { return this.metadata("generation"); }

	private metadata(key: string) {
		const value = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key)?.value;
		if (typeof value !== "string") throw new Error(UNSAFE_STORE);
		return value;
	}

	bump() { this.db.exec("UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'generation'"); }

	wavEntry(row: StoredTake) {
		const receipt = rowReceipt(row);
		if (!receipt) return undefined;
		const entry = privateEntry(this.root, leafName(row.id));
		if (entry && (ownedIdentity(entry) !== receipt.identity || fileStamp(entry) !== receipt.stamp)) throw new UnverifiedWav();
		return entry;
	}

	// Used by preview and again by the commit. A missing leaf has no bytes to
	// remove; an unrelated or altered leaf is an error, not implicit consent.
	pruneBytes(ids: readonly EntryId[]) {
		let bytes = 0;
		for (const id of ids) {
			const row = this.get(id);
			if (!row) throw new Error("Micme's current history differs from the retention preview.");
			bytes += Number(this.wavEntry(row)?.size ?? 0n);
		}
		if (!Number.isSafeInteger(bytes)) throw new Error("Micme could not count the bytes in the retention preview.");
		return bytes;
	}

	canPrune(id: EntryId) {
		try { this.pruneBytes([id]); return true; }
		catch (error) { if (error instanceof UnverifiedWav) return false; throw error; }
	}

	/** Inside a transaction: persist deletion intent and (when explicit) consent. */
	markDeletes(ids: readonly EntryId[], policy?: string) {
		const mark = this.db.prepare("UPDATE takes SET deleting = 1 WHERE id = ?");
		for (const id of ids) mark.run(id);
		if (policy !== undefined) this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'retention'").run(policy);
		if (ids.length || policy !== undefined) this.bump();
	}

	finishDeletes(allowUnsafeAudio = false) {
		const pending = this.db.prepare(`SELECT ${TAKE_FIELDS} FROM takes WHERE deleting = 1`).all() as StoredTake[];
		let blocked: UnverifiedWav | undefined;
		for (const row of pending) {
			try { this.finishDelete(row); }
			catch (error) {
				if (!(error instanceof UnverifiedWav)) throw error;
				blocked = error;
			}
		}
		if (blocked && !allowUnsafeAudio) throw blocked;
	}

	private finishDelete(row: StoredTake) {
		this.check();
		const receipt = rowReceipt(row);
		if (receipt) {
			const name = leafName(row.id);
			const trash = leafName(row.id, ".deleting");
			const stamp = receipt.stamp.slice(0, receipt.stamp.lastIndexOf(":")); // rename changes ctime
			if (privateEntry(this.root, trash)) this.unlinkClaim(trash, receipt.identity, stamp);
			else if (this.wavEntry(row)) this.claimAndUnlink(name, trash, receipt.identity, stamp);
		}
		// Persist removal before forgetting the intent, also after a restart
		// between unlink and the index commit.
		fsyncSync(this.root.fd);
		this.commit(() => this.db.prepare("DELETE FROM takes WHERE id = ? AND deleting = 1").run(row.id));
	}

	private claimAndUnlink(name: string, trash: string, expected: string, stamp?: string) {
		this.root.moveExclusive(name, trash);
		try { this.unlinkClaim(trash, expected, stamp); }
		catch (error) { this.restoreClaim(trash, name); throw error; }
	}

	private restoreClaim(claimed: string, original: string) {
		// Never overwrite a second replacement on restore.
		try { this.root.moveExclusive(claimed, original); } catch { /* Preserve both entries for repair. */ }
	}

	private unlinkClaim(name: string, expected: string, stamp?: string) {
		const found = privateEntry(this.root, name);
		if (!found || ownedIdentity(found) !== expected || (stamp !== undefined && contentStamp(found) !== stamp)) throw new UnverifiedWav();
		this.root.unlinkFile(name);
	}

	recoverInstalls(allowUnsafeAudio: boolean) {
		const pending = this.db.prepare("SELECT id, identity FROM installing").all() as { id: EntryId; identity: string }[];
		for (const { id, identity } of pending) {
			try { this.discardInstall(id, identity); }
			catch (error) { if (!(allowUnsafeAudio && error instanceof UnverifiedWav)) throw error; }
		}
	}

	private discardInstall(id: EntryId, identity: string) {
		this.check();
		const trash = leafName(id, ".abandoned");
		let removed = false;
		let replaced = false;
		if (privateEntry(this.root, trash)) {
			this.unlinkClaim(trash, identity);
			removed = true;
		}
		for (const name of [leafName(id, ".part"), leafName(id)]) {
			const entry = privateEntry(this.root, name);
			if (!entry) continue;
			if (ownedIdentity(entry) !== identity) { replaced = true; continue; }
			this.claimAndUnlink(name, trash, identity);
			removed = true;
		}
		if (replaced && !removed) throw new UnverifiedWav();
		fsyncSync(this.root.fd);
		this.commit(() => this.db.prepare("DELETE FROM installing WHERE id = ?").run(id));
	}

	async install<T>(id: EntryId, audio: VerifiedAudio | null, source: StagedInput | null, signal: Signal, publish: (receipt: FileReceipt | null) => T) {
		if (!audio || !source) return this.commit(() => publish(null));
		this.check();
		const part = leafName(id, ".part");
		const name = leafName(id);
		const fd = this.root.openFile(part, CREATE_LEAF, PRIVATE_FILE);
		let identity: string | undefined;
		let committed = false;
		try {
			const allocation = fstatSync(fd, { bigint: true });
			if (!isPrivateFile(allocation, fd)) throw new UnverifiedWav();
			identity = ownedIdentity(allocation);
			// No private audio is written before its recovery receipt is durable.
			this.commit(() => this.db.prepare("INSERT INTO installing VALUES (?, ?)").run(id, identity!));
			await copyBytes(source, audio, fd, signal);
			fsyncSync(fd);
			const complete = fstatSync(fd, { bigint: true });
			if (complete.size !== BigInt(audio.bytes) || await hashRecordingBytes(new HeldWav(fd), 0, audio.bytes, signal) !== audio.sha256) throw new UnverifiedWav();
			// Only the journaled part remains when durable publication begins.
			await source.release();
			signal.throwIfAborted();
			if (!getTransferOptions().MICME_HISTORY) throw new Error(STORE_DISABLED);
			this.check();
			const found = privateEntry(this.root, part);
			if (!found || ownedIdentity(found) !== identity || fileStamp(found) !== fileStamp(complete)) throw new UnverifiedWav();
			this.root.moveExclusive(part, name);
			const saved = privateEntry(this.root, name);
			if (!saved || ownedIdentity(saved) !== identity || contentStamp(saved) !== contentStamp(complete)) {
				this.restoreClaim(name, part);
				throw new UnverifiedWav();
			}
			fsyncSync(this.root.fd);
			const receipt = { bytes: audio.bytes, sha256: audio.sha256, identity, stamp: fileStamp(saved) };
			const value = this.commit(() => {
				const result = publish(receipt);
				this.db.prepare("DELETE FROM installing WHERE id = ?").run(id);
				return result;
			});
			committed = true;
			return value;
		} finally {
			closeSync(fd);
			if (!committed && identity && this.get(id)?.identity !== identity) this.discardInstall(id, identity);
		}
	}

	async consume<T>(row: StoredTake, signal: Signal, use: (file: FileSource, receipt: FileReceipt) => Promise<T>) {
		this.check();
		const receipt = rowReceipt(row);
		const name = leafName(row.id);
		if (!receipt || row.deleting || !this.wavEntry(row)) throw new UnverifiedWav();
		const fd = optionalLeaf(this.root, name);
		if (fd === undefined) throw new UnverifiedWav();
		try {
			const file = new HeldWav(fd);
			const check = () => this.checkWav(row, receipt, fd);
			check();
			const result = await use({ file, bytes: receipt.bytes, check }, receipt);
			signal.throwIfAborted();
			check();
			return result;
		} finally { closeSync(fd); }
	}

	private checkWav(row: StoredTake, receipt: FileReceipt, fd: number) {
		this.check();
		const stats = fstatSync(fd, { bigint: true });
		if (ownedIdentity(stats) !== receipt.identity || fileStamp(stats) !== receipt.stamp || !isPrivateFile(stats, fd) || !this.wavEntry(row)) {
			throw new UnverifiedWav();
		}
	}

	interruptDeadJobs() {
		const jobs = this.db.prepare("SELECT id, job_pid AS pid, job_token AS token FROM takes WHERE job_pid IS NOT NULL").all() as
			{ id: EntryId; pid: number; token: string | null }[];
		for (const { id, pid, token } of jobs) {
			if (!jobOwnerExited(pid) && !(pid === process.pid && token !== null && !activeRetries.has(token))) continue;
			this.commit(() => this.db.prepare(`UPDATE takes SET state = COALESCE(job_prior_state, 'interrupted'),
				job_pid = NULL, job_token = NULL, job_prior_state = NULL WHERE id = ?`).run(id));
		}
	}
}

class HeldWav implements VerifiedRecordingFile {
	private readonly fd: number;

	constructor(fd: number) { this.fd = fd; }
	identity() { return posixFileIdentity(fstatSync(this.fd, { bigint: true })); }
	snapshotStamp() {
		const stats = fstatSync(this.fd, { bigint: true });
		if (!isPrivateFile(stats, this.fd)) throw new UnverifiedWav();
		return fileStamp(stats);
	}
	size() { return fstatSync(this.fd).size; }
	async readAt(bytes: Buffer, offset: number) { return (await readAt(this.fd, bytes, 0, bytes.length, offset)).bytesRead; }
	// The scope that opened the descriptor closes it, not the reader.
	close() { /* owned by the caller */ }
}

function jobOwnerExited(pid: number) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	if (pid === process.pid) return false;
	try { process.kill(pid, 0); return false; }
	catch (error) { return errorCode(error, "ESRCH"); }
}

function rowReceipt(row: StoredTake): FileReceipt | null {
	if (row.bytes === null || row.sha256 === null || row.identity === null || row.stamp === null) return null;
	return { bytes: row.bytes, sha256: row.sha256, identity: row.identity, stamp: row.stamp };
}

function asRow(store: LibraryStore, stored: StoredTake): Row {
	const { bytes, sha256, identity: _identity, stamp: _stamp, deleting, jobToken: _token, jobPid: _pid, jobPriorState: _prior, starred, ...row } = stored;
	let wav: Row["wav"] = null;
	try { if (!deleting && bytes !== null && sha256 !== null && store.wavEntry(stored)) wav = { bytes, sha256 }; }
	catch (error) { if (!(error instanceof UnverifiedWav)) throw error; }
	return { ...row, starred: starred === 1, wav };
}

async function withStaging<T>(prefix: string, run: (target: RecordingDirectory) => Promise<T>) {
	const target = await createLiveRecordingDirectory(process.cwd(), false, prefix);
	try { return await run(target); }
	finally {
		try { await target.remove(); } catch { /* Do not relabel a committed result or delete an unverified replacement. */ }
		finally { target.close(); }
	}
}

async function withInput<T>(audio: VerifiedAudio | null, signal: Signal, use: (source: StagedInput | null) => Promise<T>) {
	if (!audio) return use(null);
	return withStaging("micme-history-stage-", async (target) => {
		const name = await audio.copyTo(target, signal);
		signal.throwIfAborted();
		const file = target.openVerifiedFile(name);
		if (!file) throw new UnverifiedWav();
		try {
			const source = bindSnapshotSource(target, name, file);
			if (source.bytes !== audio.bytes) throw new UnverifiedWav();
			await validateCompletedClipWav(file, source.bytes, signal);
			return await use({ ...source, release: removeStagedInput.bind(undefined, target, file) });
		} finally { file.close(); }
	});
}

async function removeStagedInput(target: RecordingDirectory, file: VerifiedRecordingFile) {
	file.close();
	await target.remove();
}

async function copyBytes(source: FileSource, receipt: Pick<VerifiedAudio, "bytes" | "sha256">, fd: number, signal: Signal) {
	if (source.bytes !== receipt.bytes) throw new UnverifiedWav();
	source.check();
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(Math.min(source.bytes, COPY_BLOCK_BYTES));
	for (let offset = 0; offset < source.bytes;) {
		signal.throwIfAborted();
		const length = Math.min(buffer.length, source.bytes - offset);
		const chunk = buffer.subarray(0, length);
		if (await source.file.readAt(chunk, offset) !== length) throw new UnverifiedWav();
		hash.update(chunk);
		for (let at = 0; at < length;) {
			signal.throwIfAborted();
			const { bytesWritten } = await writeAt(fd, chunk, at, length - at, offset + at);
			if (!bytesWritten) throw new Error("Micme could not write the full history audio copy.");
			at += bytesWritten;
		}
		offset += length;
	}
	signal.throwIfAborted();
	if (hash.digest("hex") !== receipt.sha256) throw new UnverifiedWav();
	source.check();
}

function receiptValues(receipt: FileReceipt | null) {
	return [receipt?.bytes ?? null, receipt?.sha256 ?? null, receipt?.identity ?? null, receipt?.stamp ?? null] as const;
}

export const saveTake: SaveTake = async (final, source, state, audio, modelId, signal, polished = null) => {
	signal.throwIfAborted();
	if (!getTransferOptions().MICME_HISTORY) throw new Error(STORE_DISABLED);
	const id = randomUUID();
	const result = await withLibrary("create", signal, (store) => withInput(audio, signal, async (wav) => {
		await store.install(id, audio, wav, signal, (receipt) => {
			store.db.prepare(`INSERT INTO takes (id, created_utc, source, language, raw, local, polished, model_id, state,
				wav_bytes, wav_sha, wav_identity, wav_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, new Date().toISOString(), source, final?.language ?? null, final?.raw ?? null, final?.local ?? null, polished, modelId, state, ...receiptValues(receipt));
			store.bump();
			const ids = retentionIds(store, store.policy());
			store.pruneBytes(ids);
			store.markDeletes(ids);
		});
		try { store.finishDeletes(); }
		catch (error) {
			// A caller that hears "save failed" must not be given a usable row
			// for this take. Keep a durable delete receipt if disk cleanup failed.
			if (store.get(id)?.deleting === 0) {
				store.commit(() => store.markDeletes([id]));
				try { store.finishDeletes(); } catch { /* Retry the recorded cleanup on reopen. */ }
			}
			throw error;
		}
		return store.get(id) ? id : null;
	}));
	if (result === undefined) throw new Error(NO_INDEX);
	return result;
};

export const updateTake: UpdateTake = async (id, change, signal) => {
	const fields: string[] = [];
	const values: SQLInputValue[] = [];
	for (const [key, column] of Object.entries(CHANGE_COLUMNS)) {
		const value = change[key as keyof typeof CHANGE_COLUMNS];
		if (value === undefined) continue;
		if ((key === "doneSamples" || key === "totalSamples") && (!Number.isSafeInteger(value) || Number(value) < 0)) {
			throw new Error("Micme requires nonnegative whole-sample job progress.");
		}
		fields.push(`${column} = ?`);
		values.push(value);
	}
	if (!fields.length) return;
	if (change.state && !["queued", "decoding", "recognizing"].includes(change.state)) fields.push("job_pid = NULL");
	await withLibrary("existing", signal, (store) => store.commit(() => {
		store.db.prepare(`UPDATE takes SET ${fields.join(", ")} WHERE id = ? AND deleting = 0 AND job_token IS NULL`).run(...values, requireId(id));
	}));
};

export const page: Page = async (before) => await withLibrary("read", NEVER_ABORTED, (store) => {
	const anchor = before === null ? null : store.get(before);
	enforceRetention(store, NEVER_ABORTED, true);
	if (before !== null && !anchor) return [];
	const ordered = "ORDER BY created_utc DESC, id DESC LIMIT ?";
	// A recovery blocked by a replacement does not make existing text inaccessible.
	const query = `SELECT ${TAKE_FIELDS} FROM takes WHERE 1`;
	const found = anchor ? store.db.prepare(`${query} AND (created_utc, id) < (?, ?) ${ordered}`).all(anchor.createdUtc, anchor.id, LIBRARY_PAGE_SIZE)
		: store.db.prepare(`${query} ${ordered}`).all(LIBRARY_PAGE_SIZE);
	return (found as StoredTake[]).map((row) => asRow(store, row));
}) ?? [];

export const star: Star = async (id, on, signal) => {
	await withLibrary("existing", signal, (store) => {
		store.commit(() => {
			const changed = store.db.prepare("UPDATE takes SET starred = ? WHERE id = ? AND starred <> ? AND deleting = 0").run(+on, requireId(id), +on);
			if (!changed.changes) return;
			store.bump();
			if (!on) {
				const ids = retentionIds(store, store.policy());
				store.pruneBytes(ids);
				store.markDeletes(ids);
			}
		});
		if (!on) store.finishDeletes();
	});
};

export const deleteRow: DeleteRow = async (id, signal) => {
	await withLibrary("existing", signal, (store) => {
		if (!store.get(id)) return;
		store.pruneBytes([id]);
		signal.throwIfAborted();
		store.commit(() => store.markDeletes([id]));
		store.finishDeletes();
	});
};

async function checkAudio(store: LibraryStore, row: StoredTake, signal: Signal) {
	return store.consume(row, signal, async ({ file, bytes }, receipt) => {
		if (await hashRecordingBytes(file, 0, bytes, signal) !== receipt.sha256) throw new UnverifiedWav();
		return verifiedReceipt(store.identity, row.id, receipt);
	});
}

function verifiedReceipt(storeId: string, id: EntryId, receipt: FileReceipt): VerifiedAudio {
	return Object.freeze({ bytes: receipt.bytes, sha256: receipt.sha256, copyTo: copySavedAudio.bind(undefined, storeId, id, receipt) });
}

export const verifiedAudio: ReadVerifiedAudio = async (id, signal) => {
	try {
		return await withLibrary("read", signal, async (store) => {
			enforceRetention(store, signal, true);
			const row = store.get(id);
			return row ? checkAudio(store, row, signal) : null;
		}) ?? null;
	} catch (error) { if (error instanceof UnverifiedWav) return null; throw error; }
};

async function copySavedAudio(storeId: string, id: EntryId, expected: FileReceipt, target: RecordingDirectory, signal: Signal) {
	const result = await withLibrary("read", signal, (store) => {
		enforceRetention(store, signal, true);
		const row = store.get(id);
		if (storeId !== store.identity || !row || row.identity !== expected.identity || row.stamp !== expected.stamp || row.sha256 !== expected.sha256) {
			throw new UnverifiedWav();
		}
		return store.consume(row, signal, (source, receipt) => copyToTarget(source, receipt, target, signal));
	});
	if (!result) throw new UnverifiedWav();
	return result;
}

async function copyToTarget(source: FileSource, receipt: Pick<VerifiedAudio, "bytes" | "sha256">, target: RecordingDirectory, signal: Signal) {
	const name = `history-${randomUUID()}.wav`;
	const fd = target.createPrivateFile(name);
	const identity = fstatSync(fd, { bigint: true });
	let copied = false;
	try {
		await copyBytes(source, receipt, fd, signal);
		if (!target.matchesPrivateFile(name, identity)) throw new UnverifiedWav();
		copied = true;
		return target.liveFilePath(name);
	} finally {
		closeSync(fd);
		if (!copied) target.discardPrivateFile(name, identity);
	}
}

export const play: Play = async (id, fromMs, signal) => {
	if (!Number.isFinite(fromMs) || fromMs < 0 || fromMs > Number.MAX_SAFE_INTEGER) throw new Error("Micme playback needs a nonnegative seek time.");
	const audio = await verifiedAudio(id, signal);
	if (!audio) throw new UnverifiedWav();
	const player = findExecutable(["ffplay"]);
	if (!player) throw new Error("Micme playback needs a local FFplay installation (part of FFmpeg).");
	await withStaging("micme-history-play-", async (target) => {
		const path = await audio.copyTo(target, signal);
		const fd = target.openFile(path, READ_LEAF);
		try {
			const bound = bindSnapshotSource(target, path, new HeldWav(fd));
			if (bound.bytes !== audio.bytes || await hashRecordingBytes(bound.file, 0, audio.bytes, signal) !== audio.sha256) throw new UnverifiedWav();
			bound.check();
			const input = process.platform === "linux" ? `/proc/${process.pid}/fd/${fd}` : path;
			const result = await runProcess(resolve(player), ["-nodisp", "-autoexit", "-nostats", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "wav", "-ss",
				String(fromMs / 1000), "-i", input], 0x7fffffff, { signal, cwdFd: target.cwdFd });
			signal.throwIfAborted();
			if (result.code !== 0 || result.timedOut || result.stderr.trim()) {
				throw new Error("Micme could not play the verified WAV with FFplay. Check the local audio output.");
			}
		} finally { closeSync(fd); }
	});
};

export const enqueueImport: EnqueueImport = async (filename, choice, signal) => {
	const result = await withLibrary("create", signal, (store) => store.commit(() => {
		const id = randomUUID();
		store.db.prepare(`INSERT INTO takes (id, created_utc, source, filename, model_id, state, job_choice, job_pid)
			VALUES (?, ?, 'import', ?, ?, 'queued', ?, ?)`).run(id, new Date().toISOString(), basename(filename), choice.variantId, JSON.stringify(choice), process.pid);
		store.bump();
		return id;
	}));
	if (!result) throw new Error(NO_INDEX);
	return result;
};

export const publishAudio: PublishAudio = async (id, audio, signal) => {
	signal.throwIfAborted();
	if (!getTransferOptions().MICME_HISTORY) throw new Error(STORE_DISABLED);
	await withLibrary("existing", signal, async (store) => {
		const row = store.get(id);
		if (!row || row.deleting) return;
		if (row.source !== "import" || rowReceipt(row)) throw new Error("Micme cannot replace a saved recording.");
		await withInput(audio, signal, (wav) => store.install(id, audio, wav, signal, (receipt) => {
			store.db.prepare("UPDATE takes SET wav_bytes = ?, wav_sha = ?, wav_identity = ?, wav_stamp = ? WHERE id = ?").run(...receiptValues(receipt), id);
			store.bump();
		}));
	});
};

export const retry: Retry = async (id, choice, signal) => {
	const { recognizeFile } = await import("./recognition.ts");
	return retryWith(id, choice, signal, recognizeFile);
};

export async function retryWith(id: EntryId, choice: Parameters<Retry>[1], signal: Signal, recognize: RecognizeFile) {
	const token = randomUUID();
	activeRetries.add(token);
	try { await runRetry(id, token, { ...choice }, signal, recognize); }
	finally { activeRetries.delete(token); }
}

async function runRetry(id: EntryId, token: string, choice: Parameters<Retry>[1], signal: Signal, recognize: RecognizeFile) {
	const attempt = await withLibrary("existing", signal, async (store) => {
		enforceRetention(store, signal, true);
		const row = store.get(id);
		if (!row) throw new UnverifiedWav();
		if (row.jobPid !== null) throw new Error("Micme already has an active history job for this take.");
		const audio = await checkAudio(store, row, signal);
		const prior = row.local === null ? null : row.state;
		store.commit(() => store.db.prepare(`UPDATE takes SET job_token = ?, job_pid = ?, job_prior_state = ?, state = 'recognizing',
			done_samples = 0, total_samples = NULL WHERE id = ?`).run(token, process.pid, prior, id));
		return { storeId: store.identity, audio, prior, row };
	});
	if (!attempt) throw new UnverifiedWav();
	let progress = Promise.resolve();
	let progressError: unknown;
	try {
		const final = await withRetryInput(attempt.audio, signal, (input) => recognize(input, choice, "retry", (done, total) => {
			progress = progress.then(async () => {
				if (signal.aborted || progressError) return;
				await updateRetry(attempt.storeId, id, token, signal, "done_samples = ?, total_samples = ?", [done, total]);
			}).catch((error: unknown) => { progressError = error; });
		}, signal));
		await progress;
		signal.throwIfAborted();
		if (progressError) throw progressError;
		if (!final.raw.trim()) throw new Error("Micme retry produced no transcript; existing text was kept.");
		const written = await updateRetry(attempt.storeId, id, token, signal, `raw = ?, local = ?, language = ?, model_id = ?, polished = NULL, state = 'ready',
			job_token = NULL, job_pid = NULL, job_prior_state = NULL`, [final.raw, final.local, final.language, choice.variantId]);
		if (!written) throw new Error("Micme could not save the retry because the history take is no longer available.");
	} catch (error) {
		await progress;
		await updateRetry(attempt.storeId, id, token, NEVER_ABORTED, `state = ?, done_samples = ?, total_samples = ?,
			job_token = NULL, job_pid = NULL, job_prior_state = NULL`,
		[attempt.prior ?? (signal.aborted ? "canceled" : "asr-failed"), attempt.row.doneSamples, attempt.row.totalSamples]);
		throw error;
	}
}

async function updateRetry(storeId: string, id: EntryId, token: string, signal: Signal, sql: string, args: SQLInputValue[]) {
	return await withLibrary("existing", signal, (store) => {
		if (store.identity !== storeId) return false;
		return Boolean(store.commit(() => store.db.prepare(`UPDATE takes SET ${sql} WHERE id = ? AND job_token = ? AND deleting = 0`).run(...args, id, token)).changes);
	}) ?? false;
}

async function withRetryInput<T>(audio: VerifiedAudio, signal: Signal, run: (audio: VerifiedAudio) => Promise<T>) {
	return withStaging("micme-history-retry-", async (directory) => {
		const input = await audio.copyTo(directory, signal);
		const fd = directory.openFile(input, READ_LEAF);
		try {
			const file = new HeldWav(fd);
			const source = bindSnapshotSource(directory, input, file);
			if (source.bytes !== audio.bytes || await hashRecordingBytes(file, 0, audio.bytes, signal) !== audio.sha256) throw new UnverifiedWav();
			source.check();
			const live = new WavHeaderScanner("live", () => new UnverifiedWav());
			const standard = await live.scan(file, audio.bytes, signal).catch((error: unknown) => {
				if (error instanceof UnverifiedWav) return undefined;
				throw error;
			});
			if (standard) {
				const receipt = { bytes: audio.bytes, sha256: audio.sha256 };
				return await run({ ...receipt, copyTo: copyToTarget.bind(undefined, source, receipt) });
			}
			// Custom/legacy clips can be complete PCM at another device rate.
			// Feed a verified local derivative to the current recognition service.
			const ffmpeg = findExecutable(["ffmpeg"]);
			if (!ffmpeg) throw new Error("Micme retry needs FFmpeg to normalize this recording's sample format.");
			const name = "retry-pcm.wav";
			const output = directory.liveFilePath(name);
			const heldInput = process.platform === "linux" ? `/proc/${process.pid}/fd/${fd}` : input;
			const result = await runProcess(resolve(ffmpeg), ["-nostdin", "-loglevel", "error", "-n", "-protocol_whitelist", "file", "-f", "wav", "-i", heldInput,
				"-ac", "1", "-ar", String(LIVE_CAPTURE_RATE), "-c:a", "pcm_s16le", output], 300_000, { signal, cwdFd: directory.cwdFd });
			signal.throwIfAborted();
			source.check();
			if (result.code !== 0) throw new Error("Micme could not normalize the verified audio for retry.");
			const normalized = directory.openVerifiedFile(name);
			if (!normalized) throw new UnverifiedWav();
			try {
				const source = bindSnapshotSource(directory, name, normalized);
				await validateCompletedClipWav(normalized, source.bytes, signal);
				return await run(await snapshotVerifiedAudio(source, directory, signal));
			} finally { normalized.close(); }
		} finally { closeSync(fd); }
	});
}

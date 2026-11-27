import { getMicmeAgentDir } from "../config.ts";
import type { ApplyPrune, EnforceActiveRetention, EntryId, PreviewPrune, Prune, Signal } from "./contracts.ts";
import type { LibraryStore } from "./library.ts";
import { parseRetentionPolicy } from "./options.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_AGAIN = "Micme local history changed; refresh the retention preview before confirming.";
const ELIGIBLE = "FROM takes WHERE starred = 0 AND source <> 'import' AND deleting = 0";
const ORDER = "ORDER BY created_utc DESC, id DESC";
const previews = new WeakMap<Prune, { scope: string; identity: string | null; generation: string }>();

export function retentionIds(store: LibraryStore, policy: string, now = Date.now()): EntryId[] {
	const parsed = parseRetentionPolicy(policy);
	if (parsed.kind === "never") return [];
	const rows = parsed.kind === "count"
		? store.db.prepare(`SELECT id ${ELIGIBLE} ${ORDER} LIMIT -1 OFFSET ?`).all(parsed.count)
		: store.db.prepare(`SELECT id ${ELIGIBLE} AND created_utc <= ? ${ORDER}`).all(new Date(now - parsed.days * DAY_MS).toISOString());
	return rows.map(({ id }) => id as EntryId);
}

export function enforceRetention(store: LibraryStore, signal: Signal, ageOnly = false) {
	const policy = store.policy();
	if (ageOnly && parseRetentionPolicy(policy).kind !== "days") return;
	let ids = retentionIds(store, policy);
	// A bad leaf cannot be claimed. On a read, still expire safe candidates
	// and let the user see copyable text; explicit enforcement reports the error.
	if (ageOnly) ids = ids.filter((id) => store.canPrune(id));
	else store.pruneBytes(ids);
	if (!ids.length) return;
	signal.throwIfAborted();
	store.commit(() => store.markDeletes(ids));
	store.finishDeletes(ageOnly);
}

export const previewPrune: PreviewPrune = async (policy) => {
	parseRetentionPolicy(policy);
	const scope = getMicmeAgentDir();
	const { withLibrary } = await import("./library.ts");
	return await withLibrary("read", new AbortController().signal, (store) => {
		const ids = retentionIds(store, policy);
		return rememberPreview({ ids, bytes: store.pruneBytes(ids), policy }, scope, store);
	}) ?? rememberPreview({ ids: [], bytes: 0, policy }, scope);
};

function rememberPreview(preview: Prune, scope: string, store?: LibraryStore) {
	Object.freeze(preview.ids);
	Object.freeze(preview);
	previews.set(preview, { scope, identity: store?.identity ?? null, generation: store?.generation() ?? "0" });
	return preview;
}

export const applyPrune: ApplyPrune = async (preview, signal) => {
	signal.throwIfAborted();
	const snapshot = previews.get(preview);
	if (!snapshot || snapshot.scope !== getMicmeAgentDir()) throw new Error(REVIEW_AGAIN);
	const { withLibrary } = await import("./library.ts");
	await withLibrary("create", signal, (store) => {
		if ((snapshot.identity !== null && snapshot.identity !== store.identity) || snapshot.generation !== store.generation()) {
			throw new Error(REVIEW_AGAIN);
		}
		const ids = retentionIds(store, preview.policy);
		if (ids.length !== preview.ids.length || ids.some((id, index) => id !== preview.ids[index]) ||
			store.pruneBytes(ids) !== preview.bytes) throw new Error(REVIEW_AGAIN);
		signal.throwIfAborted();
		// Consent and the exact current candidate set become durable together.
		// After this commit, filesystem work must finish or be recovered, not canceled.
		store.commit(() => store.markDeletes(ids, preview.policy));
		store.finishDeletes();
	});
};

export const enforceActiveRetention: EnforceActiveRetention = async (signal) => {
	signal.throwIfAborted();
	const { withLibrary } = await import("./library.ts");
	await withLibrary("existing", signal, (store) => enforceRetention(store, signal));
};

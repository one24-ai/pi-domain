/**
 * Restoring the memory database from a snapshot.
 *
 * A restore never swaps files: other sessions keep the database open, and replacing a WAL-mode
 * file under an open connection corrupts it. Instead the snapshot's rows are read first, a fresh
 * snapshot of the current state is saved (so a restore can itself be undone), and then the rows
 * replace the live ones in one transaction through the store's own connection.
 *
 * Free of pi imports so it can be tested on its own.
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDb, backupTime, listBackups } from "./backup.ts";
import { type MemoryStore, type RawMemoryRow, ROW_COLUMNS, SCHEMA_VERSION } from "./store.ts";

export interface SnapshotInfo {
	name: string;
	path: string;
	takenAt: Date | undefined;
	memories?: number;
	userVersion?: number;
	/** Why it cannot be restored, if it cannot. */
	error?: string;
}

/** Open a snapshot read-only and check it. Never throws: a damaged file is reported in `error`. */
export function inspectSnapshot(path: string): SnapshotInfo {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const info: SnapshotInfo = { name, path, takenAt: backupTime(name) };
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const check = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
		if (check !== "ok") return { ...info, error: `integrity check failed: ${check}` };
		const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		const memories = (db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
		return { ...info, memories, userVersion };
	} catch (err) {
		return { ...info, error: (err as Error).message };
	} finally {
		try {
			db?.close();
		} catch {}
	}
}

/** Every snapshot in `dir`, newest first, each inspected. */
export function listSnapshots(dir: string): SnapshotInfo[] {
	return listBackups(dir).map((name) => inspectSnapshot(join(dir, name)));
}

/** The picker line for a snapshot. */
export function snapshotLabel(s: SnapshotInfo): string {
	if (s.error) return `${s.name}  damaged`;
	return `${s.name}  ${s.memories} ${s.memories === 1 ? "memory" : "memories"}`;
}

/** A snapshot by file name, with or without ".db", or by its date stamp (20261005-125240). */
export function findSnapshot(snaps: SnapshotInfo[], want: string): SnapshotInfo | undefined {
	const w = want.trim();
	return snaps.find((s) => s.name === w) ?? snaps.find((s) => s.name === `${w}.db`) ?? snaps.find((s) => s.name === `domain-${w}.db`);
}

function readRows(path: string): RawMemoryRow[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(`SELECT ${ROW_COLUMNS.join(", ")} FROM memories ORDER BY id`).all() as unknown as RawMemoryRow[];
	} finally {
		db.close();
	}
}

export interface RestoreReport {
	from: SnapshotInfo;
	before: number;
	after: number;
	/** The snapshot of the state that was replaced. */
	safety: string;
}

/**
 * Replace every memory in `store` with those of the snapshot `name` in `dir`.
 *
 * Checks the snapshot, reads its rows, saves a snapshot of the current database (not pruned, so
 * nothing is pushed out of the rotation and the snapshot being restored cannot be deleted), then
 * replaces. If anything fails before the replace, the database is untouched. Another session's write
 * in the few milliseconds between the safety snapshot and the replace is not in the safety snapshot.
 */
export function restoreSnapshot(store: MemoryStore, livePath: string, dir: string, name: string, now: Date = new Date()): RestoreReport {
	if (!listBackups(dir).includes(name)) throw new Error(`no snapshot named ${name}`);
	const from = inspectSnapshot(join(dir, name));
	if (from.error) throw new Error(`${name} cannot be restored: ${from.error}`);
	if (from.userVersion !== SCHEMA_VERSION) throw new Error(`${name} has schema version ${from.userVersion}, this pi-domain uses ${SCHEMA_VERSION}`);
	const rows = readRows(from.path);
	const safety = backupDb(livePath, dir, now, Number.POSITIVE_INFINITY);
	const { before, after } = store.replaceAll(rows);
	return { from, before, after, safety: safety.to };
}

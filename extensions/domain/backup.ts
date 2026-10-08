/**
 * Timestamped snapshots of the memory database.
 *
 * A snapshot is taken through SQLite (see copy.ts), so it is consistent even while sessions
 * have the database open, and it is checked before it counts. Files are named
 * domain-YYYYMMDD-HHMMSS.db in local time (with -1, -2 ... if two land in the same second).
 *
 * Only files matching that name are ever listed or removed. Anything else in the directory is left
 * alone, so pointing the backup directory somewhere shared cannot delete unrelated files.
 *
 * Free of pi imports so it can be tested on its own.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type CopyReport, copyDb } from "./copy.ts";

/** How many snapshots are kept; older ones are removed after a new one succeeds. */
export const DEFAULT_KEEP = 20;

const NAME = /^domain-(\d{8}-\d{6})(?:-(\d+))?\.db$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** domain-YYYYMMDD-HHMMSS.db in local time; `n` > 0 adds a -n suffix. */
export function backupName(now: Date, n = 0): string {
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `domain-${stamp}${n > 0 ? `-${n}` : ""}.db`;
}

/** Snapshot file names in `dir`, newest first. A missing directory is an empty list. */
export function listBackups(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: { name: string; stamp: string; n: number }[] = [];
	for (const name of readdirSync(dir)) {
		const m = NAME.exec(name);
		if (m) found.push({ name, stamp: m[1]!, n: Number(m[2] ?? 0) });
	}
	found.sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1));
	return found.map((f) => f.name);
}

/** Remove all but the newest `keep` snapshots (at least 1). Returns the names removed. */
export function pruneBackups(dir: string, keep = DEFAULT_KEEP): string[] {
	const old = listBackups(dir).slice(Math.max(1, Math.floor(keep)));
	for (const name of old) rmSync(join(dir, name), { force: true });
	return old;
}

export interface BackupReport extends CopyReport {
	/** Names of older snapshots removed to stay within the limit. */
	pruned: string[];
}

/** Snapshot `from` into `dir`, verify it, then prune. Nothing is pruned if the snapshot fails. */
export function backupDb(from: string, dir: string, now: Date = new Date(), keep: number = DEFAULT_KEEP): BackupReport {
	if (from === ":memory:") throw new Error("an in-memory database has no file to back up");
	let n = 0;
	while (existsSync(join(dir, backupName(now, n)))) n++;
	const report = copyDb(from, join(dir, backupName(now, n)));
	return { ...report, pruned: pruneBackups(dir, keep) };
}

/** When a snapshot was taken, from its name (local time); undefined if the name is not a snapshot's. */
export function backupTime(name: string): Date | undefined {
	const m = NAME.exec(name);
	if (!m) return undefined;
	const t = m[1]!; // YYYYMMDD-HHMMSS
	const d = new Date(Number(t.slice(0, 4)), Number(t.slice(4, 6)) - 1, Number(t.slice(6, 8)), Number(t.slice(9, 11)), Number(t.slice(11, 13)), Number(t.slice(13, 15)));
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Hours between automatic snapshots by default. */
export const DEFAULT_AUTO_HOURS = 24;

/** True when the newest snapshot is at least `hours` old (or there is none, or its date is in the future). */
export function backupDue(dir: string, now: Date, hours: number): boolean {
	if (hours <= 0) return false;
	const newest = listBackups(dir)[0];
	const taken = newest ? backupTime(newest) : undefined;
	if (!taken) return true;
	const age = now.getTime() - taken.getTime();
	return age < 0 || age >= hours * 3_600_000;
}

export type AutoBackupResult = { status: "disabled" | "not-due" | "empty" } | { status: "done"; report: BackupReport };

/**
 * The snapshot taken at session start when the newest one is old enough. Skipped when switched off,
 * when the database has no memories (an empty snapshot would only push real ones out of the
 * rotation), and when a snapshot is recent. Throws if the snapshot fails, unless another session
 * took one in the meantime.
 */
export function autoBackup(opts: { from: string; dir: string; memories: number; now?: Date; hours?: number; keep?: number }): AutoBackupResult {
	const now = opts.now ?? new Date();
	const hours = opts.hours ?? DEFAULT_AUTO_HOURS;
	if (hours <= 0 || opts.from === ":memory:") return { status: "disabled" };
	if (opts.memories === 0) return { status: "empty" };
	if (!backupDue(opts.dir, now, hours)) return { status: "not-due" };
	try {
		return { status: "done", report: backupDb(opts.from, opts.dir, now, opts.keep) };
	} catch (err) {
		// Several sessions can start together; if another one just took the snapshot, all is well.
		if (!backupDue(opts.dir, now, hours)) return { status: "not-due" };
		throw err;
	}
}

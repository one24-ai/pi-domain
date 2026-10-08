/**
 * Copy a database through SQLite (VACUUM INTO), never by copying files.
 *
 * The database runs in WAL mode and other pi sessions may have it open, so copying domain.db alone
 * can lose the writes still sitting in domain.db-wal. VACUUM INTO reads one consistent snapshot,
 * including the WAL. The source is opened read-only, so its contents never change. SQLite may
 * still create empty -wal and -shm files beside it (it does for any reader of a WAL database);
 * they hold no data of their own.
 *
 * Free of pi imports so it can be tested on its own.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CopyReport {
	from: string;
	to: string;
	memories: number;
	userVersion: number;
}

function count(db: DatabaseSync): number {
	return (db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
}

function userVersion(db: DatabaseSync): number {
	return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Copy `from` to a new file `to`, then check the copy. Refuses to overwrite. Removes the copy if a check fails. */
export function copyDb(from: string, to: string): CopyReport {
	if (!existsSync(from)) throw new Error(`no database at ${from}`);
	if (existsSync(to)) throw new Error(`refusing to overwrite ${to}`);
	mkdirSync(dirname(to), { recursive: true });

	const src = new DatabaseSync(from, { readOnly: true });
	try {
		src.exec("PRAGMA busy_timeout = 5000");
		const expected = { memories: count(src), userVersion: userVersion(src) };
		src.prepare("VACUUM INTO ?").run(to);

		const dst = new DatabaseSync(to, { readOnly: true });
		try {
			const check = (dst.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
			if (check !== "ok") throw new Error(`integrity check failed on the copy: ${check}`);
			const got = { memories: count(dst), userVersion: userVersion(dst) };
			if (got.memories !== expected.memories) throw new Error(`copy has ${got.memories} memories, source has ${expected.memories}`);
			if (got.userVersion !== expected.userVersion) throw new Error(`copy has schema version ${got.userVersion}, source has ${expected.userVersion}`);
			return { from, to, ...got };
		} catch (err) {
			dst.close();
			rmSync(to, { force: true });
			throw err;
		} finally {
			try {
				dst.close();
			} catch {}
		}
	} finally {
		src.close();
	}
}

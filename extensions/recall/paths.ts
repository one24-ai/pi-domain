/**
 * Where pi-recall keeps its database and snapshots.
 *
 * PI_RECALL_DB names the database file. Otherwise it lives in the XDG data directory:
 * $XDG_DATA_HOME/pi-recall/recall.db, else ~/.local/share/pi-recall/recall.db.
 *
 * Free of pi imports so it can be tested on its own.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type DbSource = "env" | "default";

export interface DbLocation {
	path: string;
	source: DbSource;
}

type Env = Record<string, string | undefined>;

/** The directory holding the database and its backups. */
export function dataDir(env: Env = process.env, home: string = homedir()): string {
	const xdg = env.XDG_DATA_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "pi-recall");
}

export function defaultDbPath(env: Env = process.env, home: string = homedir()): string {
	return join(dataDir(env, home), "recall.db");
}

export function resolveDb(env: Env = process.env, home: string = homedir()): DbLocation {
	if (env.PI_RECALL_DB) return { path: env.PI_RECALL_DB, source: "env" };
	return { path: defaultDbPath(env, home), source: "default" };
}

/**
 * Where snapshots of this database go: a `backups` folder beside it. For an overridden database
 * that keeps a test or a second database from writing into, or pruning, the real backups.
 */
export function backupDirFor(loc: DbLocation): string {
	return join(dirname(loc.path), "backups");
}

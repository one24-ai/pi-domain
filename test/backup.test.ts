/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDb, backupName, DEFAULT_KEEP, listBackups, pruneBackups } from "../extensions/recall/backup.ts";
import { MemoryStore } from "../extensions/recall/store.ts";

const temp = () => mkdtempSync(join(tmpdir(), "pi-recall-bak-"));
const at = (h: number, m: number, s: number) => new Date(2026, 9, 5, h, m, s);

function seed(path: string, texts: string[]): MemoryStore {
	const store = new MemoryStore(path);
	for (const text of texts) store.write({ scope: "global", kind: "fact", text });
	return store;
}

test("names are recall-YYYYMMDD-HHMMSS.db in local time, with a suffix for repeats", () => {
	assert.equal(backupName(at(9, 5, 3)), "recall-20261005-090503.db");
	assert.equal(backupName(at(9, 5, 3), 2), "recall-20261005-090503-2.db");
	assert.equal(backupName(new Date(2026, 0, 2, 23, 59, 59)), "recall-20260102-235959.db");
});

test("a backup holds every memory, including writes still in the WAL of an open database", () => {
	const dir = temp();
	try {
		const live = seed(join(dir, "live", "recall.db"), ["one", "two"]);
		assert.ok(existsSync(join(dir, "live", "recall.db-wal")));
		const r = backupDb(join(dir, "live", "recall.db"), join(dir, "backups"), at(10, 0, 0));
		assert.equal(r.memories, 2);
		assert.equal(r.to, join(dir, "backups", "recall-20261005-100000.db"));
		const copy = new MemoryStore(r.to);
		assert.deepEqual(copy.recall(["global"], 10).map((m) => m.text).sort(), ["one", "two"]);
		copy.close();
		live.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two backups in the same second both survive", () => {
	const dir = temp();
	try {
		seed(join(dir, "recall.db"), ["a"]).close();
		const first = backupDb(join(dir, "recall.db"), join(dir, "b"), at(10, 0, 0));
		const second = backupDb(join(dir, "recall.db"), join(dir, "b"), at(10, 0, 0));
		assert.notEqual(first.to, second.to);
		assert.match(second.to, /recall-20261005-100000-1\.db$/);
		assert.deepEqual(listBackups(join(dir, "b")), ["recall-20261005-100000-1.db", "recall-20261005-100000.db"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listBackups is newest first and ignores files that are not snapshots", () => {
	const dir = temp();
	try {
		for (const f of ["recall-20261005-100000.db", "recall-20261004-235959.db", "recall-20261005-100000-1.db", "notes.txt", "recall.db", "recall-2026.db", "recall-20261005-100000.db-wal"]) {
			writeFileSync(join(dir, f), "x");
		}
		assert.deepEqual(listBackups(dir), ["recall-20261005-100000-1.db", "recall-20261005-100000.db", "recall-20261004-235959.db"]);
		assert.deepEqual(listBackups(join(dir, "missing")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pruning keeps the newest N, never touches other files, and never goes below one", () => {
	const dir = temp();
	try {
		for (let d = 1; d <= 5; d++) writeFileSync(join(dir, `recall-2026100${d}-120000.db`), "x");
		writeFileSync(join(dir, "keep-me.txt"), "x");
		assert.deepEqual(pruneBackups(dir, 2), ["recall-20261003-120000.db", "recall-20261002-120000.db", "recall-20261001-120000.db"]);
		assert.deepEqual(readdirSync(dir).sort(), ["keep-me.txt", "recall-20261004-120000.db", "recall-20261005-120000.db"]);
		assert.deepEqual(pruneBackups(dir, 0), ["recall-20261004-120000.db"], "keep 0 still keeps the newest");
		assert.deepEqual(listBackups(dir), ["recall-20261005-120000.db"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backupDb prunes to the limit after a successful snapshot", () => {
	const dir = temp();
	try {
		seed(join(dir, "recall.db"), ["a"]).close();
		for (let s = 0; s < 4; s++) backupDb(join(dir, "recall.db"), join(dir, "b"), at(10, 0, s), 3);
		const files = listBackups(join(dir, "b"));
		assert.equal(files.length, 3);
		assert.equal(files[0], "recall-20261005-100003.db");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed snapshot removes nothing and leaves no partial file", () => {
	const dir = temp();
	try {
		const backups = join(dir, "b");
		mkdirSync(backups);
		writeFileSync(join(backups, "recall-20260101-000000.db"), "old");
		writeFileSync(join(dir, "bad.db"), "garbage".repeat(200));
		assert.throws(() => backupDb(join(dir, "bad.db"), backups, at(10, 0, 0), 1));
		assert.deepEqual(readdirSync(backups), ["recall-20260101-000000.db"]);
		assert.throws(() => backupDb(join(dir, "missing.db"), backups, at(10, 0, 0), 1), /no database/);
		assert.deepEqual(readdirSync(backups), ["recall-20260101-000000.db"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an in-memory database cannot be backed up, and the limit defaults to 20", () => {
	assert.throws(() => backupDb(":memory:", join(tmpdir(), "nope")), /in-memory/);
	assert.equal(DEFAULT_KEEP, 20);
});

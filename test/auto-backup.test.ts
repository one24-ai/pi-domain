/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoBackup, backupDb, backupDue, backupTime } from "../extensions/recall/backup.ts";
import { MemoryStore } from "../extensions/recall/store.ts";

const temp = () => mkdtempSync(join(tmpdir(), "pi-recall-auto-"));
const at = (day: number, h = 12, m = 0, s = 0) => new Date(2026, 9, day, h, m, s);

function seed(path: string, n: number): MemoryStore {
	const store = new MemoryStore(path);
	for (let i = 0; i < n; i++) store.write({ scope: "global", kind: "fact", text: `note ${i}` });
	return store;
}

test("backupTime reads the local date from a snapshot's name", () => {
	assert.equal(backupTime("recall-20261005-125240.db")?.getTime(), at(5, 12, 52, 40).getTime());
	assert.equal(backupTime("recall-20261005-125240-3.db")?.getTime(), at(5, 12, 52, 40).getTime());
	assert.equal(backupTime("recall.db"), undefined);
	assert.equal(backupTime("recall-20261005-125240.db-wal"), undefined);
});

test("a snapshot is due with no snapshots, at exactly the interval, and when the newest is dated in the future", () => {
	const dir = temp();
	try {
		assert.equal(backupDue(join(dir, "none"), at(5), 24), true, "no directory");
		mkdirSync(join(dir, "b"));
		assert.equal(backupDue(join(dir, "b"), at(5), 24), true, "empty directory");
		writeFileSync(join(dir, "b", "recall-20261005-120000.db"), "x");
		assert.equal(backupDue(join(dir, "b"), at(6, 11, 59, 59), 24), false, "a second short of 24 hours");
		assert.equal(backupDue(join(dir, "b"), at(6, 12, 0, 0), 24), true, "exactly 24 hours");
		assert.equal(backupDue(join(dir, "b"), at(4), 24), true, "clock went backwards");
		assert.equal(backupDue(join(dir, "b"), at(9), 0), false, "0 hours means off");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("autoBackup takes a snapshot when due, and not again until the interval has passed", () => {
	const dir = temp();
	try {
		const live = seed(join(dir, "recall.db"), 3);
		const opts = { from: join(dir, "recall.db"), dir: join(dir, "b"), memories: 3, hours: 24 };
		const first = autoBackup({ ...opts, now: at(5, 9) });
		assert.equal(first.status, "done");
		assert.equal(readdirSync(join(dir, "b")).length, 1);
		assert.equal(autoBackup({ ...opts, now: at(5, 20) }).status, "not-due");
		assert.equal(autoBackup({ ...opts, now: at(6, 8, 59) }).status, "not-due");
		assert.equal(autoBackup({ ...opts, now: at(6, 9, 0) }).status, "done");
		assert.equal(readdirSync(join(dir, "b")).length, 2);
		live.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("autoBackup does nothing when switched off, for an empty database, or for :memory:", () => {
	const dir = temp();
	try {
		const base = { from: join(dir, "recall.db"), dir: join(dir, "b"), now: at(5) };
		assert.equal(autoBackup({ ...base, memories: 9, hours: 0 }).status, "disabled");
		assert.equal(autoBackup({ ...base, memories: 0, hours: 24 }).status, "empty");
		assert.equal(autoBackup({ ...base, from: ":memory:", memories: 9, hours: 24 }).status, "disabled");
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failing snapshot raises, unless another session has just taken one", () => {
	const dir = temp();
	try {
		writeFileSync(join(dir, "bad.db"), "garbage".repeat(100));
		const opts = { from: join(dir, "bad.db"), dir: join(dir, "b"), memories: 1, hours: 24, now: at(5) };
		assert.throws(() => autoBackup(opts));
		assert.deepEqual(readdirSync(join(dir, "b")).filter((f) => f.endsWith(".db")), [], "no partial file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("automatic snapshots prune like manual ones, and keep the rotation to the limit", () => {
	const dir = temp();
	try {
		seed(join(dir, "recall.db"), 1).close();
		for (let d = 1; d <= 5; d++) autoBackup({ from: join(dir, "recall.db"), dir: join(dir, "b"), memories: 1, hours: 24, now: at(d), keep: 3 });
		assert.deepEqual(readdirSync(join(dir, "b")).sort(), ["recall-20261003-120000.db", "recall-20261004-120000.db", "recall-20261005-120000.db"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backupDb still works through the shared helper", () => {
	const dir = temp();
	try {
		seed(join(dir, "recall.db"), 2).close();
		assert.equal(backupDb(join(dir, "recall.db"), join(dir, "b"), at(5)).memories, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

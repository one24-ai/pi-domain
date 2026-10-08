/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupDb, listBackups } from "../extensions/domain/backup.ts";
import { findSnapshot, inspectSnapshot, listSnapshots, restoreSnapshot, snapshotLabel } from "../extensions/domain/restore.ts";
import { MemoryStore } from "../extensions/domain/store.ts";

const temp = () => mkdtempSync(join(tmpdir(), "pi-domain-restore-"));
const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 5, h, m, s);
const texts = (s: MemoryStore) => s.recall(["global"], 50).map((m) => m.text).sort();
const idOf = (s: MemoryStore, text: string) => s.recall(["global"], 50).find((m) => m.text === text)!.id;

/** A live store with "alpha", "bravo", "charlie", and a snapshot taken at 09:00 of that state. */
function setup(dir: string) {
	const live = join(dir, "domain.db");
	const store = new MemoryStore(live);
	for (const t of ["alpha", "bravo", "charlie"]) store.write({ scope: "global", kind: "fact", text: t });
	const snap = backupDb(live, join(dir, "b"), at(9));
	return { store, live, backups: join(dir, "b"), snapName: snap.to.slice(snap.to.lastIndexOf("/") + 1) };
}

test("restoring brings back deleted and edited memories, with their ids", () => {
	const dir = temp();
	try {
		const { store, live, backups, snapName } = setup(dir);
		const idOfBravo = idOf(store, "bravo");
		store.forget(idOfBravo);
		store.update(idOf(store, "alpha"), { text: "alpha edited" });
		store.write({ scope: "global", kind: "fact", text: "delta" });
		assert.deepEqual(texts(store), ["alpha edited", "charlie", "delta"]);
		const r = restoreSnapshot(store, live, backups, snapName, at(10));
		assert.equal(r.before, 3);
		assert.equal(r.after, 3);
		assert.deepEqual(texts(store), ["alpha", "bravo", "charlie"]);
		assert.equal(store.get(idOfBravo)?.text, "bravo", "the deleted memory has its old id again");
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a restore first saves the state it replaces, so it can be undone", () => {
	const dir = temp();
	try {
		const { store, live, backups, snapName } = setup(dir);
		store.write({ scope: "global", kind: "fact", text: "written after the snapshot" });
		const r = restoreSnapshot(store, live, backups, snapName, at(10));
		assert.ok(!texts(store).includes("written after the snapshot"));
		assert.equal(inspectSnapshot(r.safety).memories, 4);
		const undo = restoreSnapshot(store, live, backups, r.safety.slice(r.safety.lastIndexOf("/") + 1), at(11));
		assert.ok(texts(store).includes("written after the snapshot"), "restoring the safety snapshot undoes it");
		assert.equal(undo.after, 4);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the safety snapshot is never pruned, so the snapshot being restored cannot be deleted by the restore", () => {
	const dir = temp();
	try {
		const { store, live, backups, snapName } = setup(dir);
		for (let s = 1; s <= 25; s++) backupDb(live, backups, at(9, 1, s), 100);
		const before = listBackups(backups).length;
		restoreSnapshot(store, live, backups, snapName, at(12));
		assert.equal(listBackups(backups).length, before + 1, "one added, none removed");
		assert.ok(listBackups(backups).includes(snapName));
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the search index matches the restored rows, and new ids do not reuse old ones", () => {
	const dir = temp();
	try {
		const { store, live, backups, snapName } = setup(dir);
		store.write({ scope: "global", kind: "fact", text: "needle written later" });
		const highest = Math.max(...store.recall(["global"], 50).map((m) => m.id));
		restoreSnapshot(store, live, backups, snapName, at(10));
		assert.equal(store.search({ scopes: ["global"], query: "needle" }).length, 0, "the removed note is gone from search");
		assert.deepEqual(store.search({ scopes: ["global"], query: "bravo" }).map((m) => m.text), ["bravo"], "a restored note is searchable");
		const fresh = store.write({ scope: "global", kind: "fact", text: "after restore" }).row.id;
		assert.ok(fresh > highest, `new id ${fresh} is above the old high-water mark ${highest}`);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a damaged, missing or wrong-version snapshot is refused and changes nothing", () => {
	const dir = temp();
	try {
		const { store, live, backups } = setup(dir);
		writeFileSync(join(backups, "domain-20261005-100000.db"), "garbage".repeat(200));
		const old = new DatabaseSync(join(backups, "domain-20261005-110000.db"));
		old.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT); PRAGMA user_version = 99");
		old.close();
		const before = texts(store);
		const files = readdirSync(backups).sort();
		assert.throws(() => restoreSnapshot(store, live, backups, "domain-20261005-100000.db", at(12)), /cannot be restored/);
		assert.throws(() => restoreSnapshot(store, live, backups, "domain-20261005-110000.db", at(12)), /schema version 99/);
		assert.throws(() => restoreSnapshot(store, live, backups, "domain-20200101-000000.db", at(12)), /no snapshot named/);
		assert.throws(() => restoreSnapshot(store, live, backups, "../domain.db", at(12)), /no snapshot named/, "a path is not a snapshot name");
		assert.deepEqual(texts(store), before);
		assert.deepEqual(readdirSync(backups).sort(), files, "and no safety snapshot was written");
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failure inside the replace rolls everything back", () => {
	const dir = temp();
	try {
		const { store } = setup(dir);
		const good = store.recall(["global"], 10).length;
		const dup = { id: 1, scope: "global", kind: "fact", text: "x", norm_hash: "same", tags: "[]", pinned: 0, created_at: 1, updated_at: 1, session_id: null };
		assert.throws(() => store.replaceAll([dup, { ...dup, id: 2 }]), /UNIQUE|constraint/i, "two rows with one hash break the unique index");
		assert.equal(store.recall(["global"], 10).length, good, "the original rows are all still there");
		assert.deepEqual(store.search({ scopes: ["global"], query: "alpha" }).map((m) => m.text), ["alpha"], "and still searchable");
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a restore while another connection has the database open works, and that connection sees the result", () => {
	const dir = temp();
	try {
		const { store, live, backups, snapName } = setup(dir);
		const other = new MemoryStore(live); // a second session
		store.write({ scope: "global", kind: "fact", text: "extra" });
		assert.equal(other.recall(["global"], 10).length, 4);
		restoreSnapshot(store, live, backups, snapName, at(10));
		assert.deepEqual(texts(other), ["alpha", "bravo", "charlie"]);
		other.close();
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listing shows snapshots newest first with their counts, and marks a damaged one", () => {
	const dir = temp();
	try {
		const { store, backups } = setup(dir);
		backupDb(join(dir, "domain.db"), backups, at(15));
		writeFileSync(join(backups, "domain-20261005-120000.db"), "garbage".repeat(200));
		const snaps = listSnapshots(backups);
		assert.deepEqual(snaps.map((s) => s.name), ["domain-20261005-150000.db", "domain-20261005-120000.db", "domain-20261005-090000.db"]);
		assert.deepEqual(snaps.map(snapshotLabel), ["domain-20261005-150000.db  3 memories", "domain-20261005-120000.db  damaged", "domain-20261005-090000.db  3 memories"]);
		assert.ok(snaps[1]!.error);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findSnapshot accepts the file name, the name without .db, or just the date stamp", () => {
	const dir = temp();
	try {
		const { store, backups } = setup(dir);
		const snaps = listSnapshots(backups);
		for (const want of ["domain-20261005-090000.db", "domain-20261005-090000", "20261005-090000", " 20261005-090000 "]) {
			assert.equal(findSnapshot(snaps, want)?.name, "domain-20261005-090000.db", want);
		}
		assert.equal(findSnapshot(snaps, "20261005"), undefined);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a snapshot of an empty database restores to an empty database", () => {
	const dir = temp();
	try {
		const live = join(dir, "domain.db");
		const store = new MemoryStore(live);
		const empty = backupDb(live, join(dir, "b"), at(8));
		store.write({ scope: "global", kind: "fact", text: "x" });
		const r = restoreSnapshot(store, live, join(dir, "b"), empty.to.slice(empty.to.lastIndexOf("/") + 1), at(9));
		assert.equal(r.after, 0);
		assert.deepEqual(texts(store), []);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

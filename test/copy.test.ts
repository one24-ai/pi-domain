/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { copyDb } from "../extensions/recall/copy.ts";
import { MemoryStore } from "../extensions/recall/store.ts";

function temp(): string {
	return mkdtempSync(join(tmpdir(), "pi-recall-copy-"));
}

/** A WAL-mode database with rows that have not been checkpointed into the main file. */
function seed(path: string, rows: string[]): MemoryStore {
	const s = new MemoryStore(path);
	for (const text of rows) s.write({ scope: "global", kind: "fact", text });
	return s;
}

test("copies every memory, including writes still in the WAL of a database that is open", () => {
	const dir = temp();
	try {
		const from = join(dir, "old", "memory.db");
		const to = join(dir, "new", "sub", "recall.db");
		const open = seed(from, ["one", "two", "three"]); // left open: a live session
		assert.ok(existsSync(`${from}-wal`), "the writes are in the WAL");
		const r = copyDb(from, to);
		assert.equal(r.memories, 3);
		const copy = new MemoryStore(to);
		assert.deepEqual(copy.recall(["global"], 10).map((m) => m.text).sort(), ["one", "three", "two"]);
		copy.close();
		open.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("leaves the source's contents untouched", () => {
	const dir = temp();
	try {
		const from = join(dir, "memory.db");
		seed(from, ["a"]).close();
		const hash = () => createHash("sha256").update(readFileSync(from)).digest("hex");
		const before = hash();
		copyDb(from, join(dir, "x", "recall.db"));
		assert.equal(hash(), before, "the main file is byte-identical");
		assert.equal(new MemoryStore(from).recall(["global"], 10).length, 1, "and still readable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the copy keeps the schema version and the search index", () => {
	const dir = temp();
	try {
		const from = join(dir, "memory.db");
		seed(from, ["findable needle"]).close();
		const to = join(dir, "recall.db");
		const r = copyDb(from, to);
		assert.equal(r.userVersion, 1);
		const copy = new MemoryStore(to);
		assert.equal(copy.search({ query: "needle", scopes: ["global"], limit: 5 }).length, 1);
		copy.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refuses to overwrite an existing destination and leaves it alone", () => {
	const dir = temp();
	try {
		const from = join(dir, "memory.db");
		seed(from, ["a"]).close();
		const to = join(dir, "recall.db");
		writeFileSync(to, "not a database");
		assert.throws(() => copyDb(from, to), /refusing to overwrite/);
		assert.equal(statSync(to).size, "not a database".length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing source is an error and creates nothing", () => {
	const dir = temp();
	try {
		assert.throws(() => copyDb(join(dir, "none.db"), join(dir, "out", "recall.db")), /no database/);
		assert.ok(!existsSync(join(dir, "out")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a source that is not a database fails and leaves no destination behind", () => {
	const dir = temp();
	try {
		const from = join(dir, "bad.db");
		writeFileSync(from, "garbage".repeat(200));
		assert.throws(() => copyDb(from, join(dir, "recall.db")));
		assert.ok(!existsSync(join(dir, "recall.db")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

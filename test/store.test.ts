/**
 * Store tests. Run with:
 *   pnpm test
 *
 * No pi imports, so this runs standalone against node:sqlite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatchExpression, MemoryStore } from "../extensions/recall/store.ts";

function newStore(): MemoryStore {
	return new MemoryStore(":memory:");
}

test("writes and reads back a memory", () => {
	const s = newStore();
	const { row, deduplicated } = s.write({
		scope: "project:foo",
		kind: "decision",
		text: "Use pnpm, never npm.",
		tags: ["tooling"],
	});
	assert.equal(deduplicated, false);
	assert.equal(row.text, "Use pnpm, never npm.");
	assert.deepEqual(row.tags, ["tooling"]);
	assert.equal(s.get(row.id)?.id, row.id);
	s.close();
});

test("deduplicates on normalised text within a scope", () => {
	const s = newStore();
	const a = s.write({ scope: "project:foo", kind: "fact", text: "Build uses Vite." });
	const b = s.write({ scope: "project:foo", kind: "fact", text: "  build   USES vite.  " });
	assert.equal(b.deduplicated, true);
	assert.equal(b.row.id, a.row.id);
	assert.equal(s.stats(["project:foo"])[0].count, 1);
	// Same text in a different scope is a distinct memory.
	const c = s.write({ scope: "global", kind: "fact", text: "Build uses Vite." });
	assert.equal(c.deduplicated, false);
	s.close();
});

test("dedup preserves an existing pin", () => {
	const s = newStore();
	const a = s.write({ scope: "global", kind: "preference", text: "Dark theme.", pinned: true });
	const b = s.write({ scope: "global", kind: "preference", text: "Dark theme." });
	assert.equal(b.row.id, a.row.id);
	assert.equal(b.row.pinned, true, "pin must not be cleared by a later unpinned write");
	s.close();
});

test("full-text search ranks matches and respects scope", () => {
	const s = newStore();
	s.write({ scope: "project:foo", kind: "gotcha", text: "The migration step needs DATABASE_URL set." });
	s.write({ scope: "project:foo", kind: "fact", text: "Tests run under vitest." });
	s.write({ scope: "project:bar", kind: "fact", text: "Unrelated migration notes." });

	const hits = s.search({ scopes: ["project:foo", "global"], query: "migration" });
	assert.equal(hits.length, 1);
	assert.match(hits[0].text, /DATABASE_URL/);

	const stemmed = s.search({ scopes: ["project:foo"], query: "testing" });
	assert.equal(stemmed.length, 1, "porter stemming should match tests/testing");
	s.close();
});

test("search filters by kind and honours limit", () => {
	const s = newStore();
	s.write({ scope: "global", kind: "fact", text: "alpha one" });
	s.write({ scope: "global", kind: "decision", text: "alpha two" });
	s.write({ scope: "global", kind: "decision", text: "alpha three" });

	assert.equal(s.search({ scopes: ["global"], query: "alpha", kinds: ["decision"] }).length, 2);
	assert.equal(s.search({ scopes: ["global"], query: "alpha", limit: 1 }).length, 1);
	s.close();
});

test("search with no query lists by recency with pinned first", () => {
	const s = newStore();
	s.write({ scope: "global", kind: "fact", text: "older" });
	const pinned = s.write({ scope: "global", kind: "fact", text: "pinned item", pinned: true });
	s.write({ scope: "global", kind: "fact", text: "newest" });

	const rows = s.search({ scopes: ["global"] });
	assert.equal(rows[0].id, pinned.row.id);
	assert.equal(rows[1].text, "newest");
	s.close();
});

test("recall returns all pinned rows then fills with recent", () => {
	const s = newStore();
	for (let i = 0; i < 5; i++) s.write({ scope: "global", kind: "fact", text: `plain ${i}` });
	s.write({ scope: "global", kind: "preference", text: "pinned a", pinned: true });
	s.write({ scope: "global", kind: "preference", text: "pinned b", pinned: true });

	const rows = s.recall(["global"], 3);
	assert.equal(rows.length, 3);
	assert.equal(rows.filter((r) => r.pinned).length, 2);

	// A limit below the pinned count must not drop pinned memories.
	assert.equal(s.recall(["global"], 1).filter((r) => r.pinned).length, 2);
	s.close();
});

test("forget and setPinned mutate and report correctly", () => {
	const s = newStore();
	const { row } = s.write({ scope: "global", kind: "fact", text: "temporary" });
	assert.equal(s.setPinned(row.id, true), true);
	assert.equal(s.get(row.id)?.pinned, true);
	assert.equal(s.forget(row.id), true);
	assert.equal(s.get(row.id), undefined);
	assert.equal(s.forget(row.id), false);
	assert.equal(s.search({ scopes: ["global"], query: "temporary" }).length, 0, "FTS row must be removed too");
	s.close();
});

test("FTS index follows text updates", () => {
	const s = newStore();
	const a = s.write({ scope: "global", kind: "fact", text: "uses webpack" });
	// A dedup write cannot change text; write a distinct row and confirm the
	// trigger keeps the index aligned after an UPDATE of text.
	s.write({ scope: "global", kind: "fact", text: "uses webpack " }); // same after normalising
	assert.equal(s.search({ scopes: ["global"], query: "webpack" }).length, 1);
	assert.equal(s.get(a.row.id)?.text, "uses webpack ");
	s.close();
});

test("search survives FTS metacharacters in the query", () => {
	const s = newStore();
	s.write({ scope: "global", kind: "gotcha", text: "Avoid the NEAR operator in queries." });
	for (const q of ['NEAR("a" "b")', "foo* -bar", 'col:"x"', '"""', "^^^", "-", "*"]) {
		assert.doesNotThrow(() => s.search({ scopes: ["global"], query: q }), `query ${q} must not throw`);
	}
	s.close();
});

test("buildMatchExpression sanitises input", () => {
	assert.equal(buildMatchExpression("pnpm build"), '"pnpm" OR "build"');
	assert.equal(buildMatchExpression("foo* -bar"), '"foo" OR "bar"');
	assert.equal(buildMatchExpression("*"), undefined);
	assert.equal(buildMatchExpression("a"), undefined, "single characters are dropped as noise");
});

test("stats aggregates per scope", () => {
	const s = newStore();
	s.write({ scope: "global", kind: "fact", text: "g1", pinned: true });
	s.write({ scope: "project:foo", kind: "fact", text: "p1" });
	s.write({ scope: "project:foo", kind: "fact", text: "p2" });

	const all = s.stats();
	assert.deepEqual(all, [
		{ scope: "global", count: 1, pinned: 1 },
		{ scope: "project:foo", count: 2, pinned: 0 },
	]);
	assert.deepEqual(s.stats(["project:foo"]), [{ scope: "project:foo", count: 2, pinned: 0 }]);
	s.close();
});

test("close is idempotent", () => {
	const s = newStore();
	s.close();
	assert.doesNotThrow(() => s.close());
});

test("supersededIds finds replacements but not extensions", async () => {
	const { supersededIds } = await import("../extensions/recall/store.ts");
	assert.deepEqual(supersededIds("Supersedes memory #33: Docker lives elsewhere."), [33]);
	assert.deepEqual(supersededIds("Supersedes #9 and #13; also extends #14."), [9, 13]);
	assert.deepEqual(supersededIds("Extends pinned memory #9: more patches."), []);
});

test("update revises in place, keeps id, refuses duplicates", () => {
	const s = newStore();
	const a = s.write({ scope: "project:foo", kind: "fact", text: "Old fact." }).row;
	const b = s.write({ scope: "project:foo", kind: "fact", text: "Other fact." }).row;
	const u = s.update(a.id, { text: "New fact.", pinned: true })!;
	assert.equal(u.id, a.id);
	assert.equal(u.text, "New fact.");
	assert.equal(u.pinned, true);
	assert.equal(s.search({ scopes: ["project:foo"], query: "New" })[0]?.id, a.id);
	assert.equal(s.search({ scopes: ["project:foo"], query: "Old" }).length, 0);
	assert.throws(() => s.update(a.id, { text: "other FACT." }), /already has that text/);
	assert.equal(s.update(b.id, { scope: "global" })!.scope, "global");
	assert.equal(s.update(999, { text: "x" }), undefined);
	s.close();
});

test("tidyCandidates: superseded, partial, old summaries, similar; never deletes", () => {
	const s = newStore();
	const scope = "project:foo";
	const old = s.write({ scope, kind: "fact", text: "No Docker registry is available for images." }).row;
	const repl = s.write({ scope, kind: "fact", text: `Supersedes memory #${old.id}: images come from registry.example.` }).row;
	const base = s.write({ scope, kind: "fact", text: "The kc shell function switches without fetching; pi uses kc too." }).row;
	s.write({ scope, kind: "fact", text: `Supersedes the last clause of memory #${base.id}: kc now fetches first.` });
	for (let i = 0; i < 4; i++) s.write({ scope, kind: "summary", text: `Session summary number ${i}.` });
	const p1 = s.write({ scope, kind: "gotcha", text: "pnpm twelve ignores npm_config_registry and needs pnpm_config_registry for registry overrides." }).row;
	const p2 = s.write({ scope, kind: "gotcha", text: "pnpm twelve ignores npm_config_registry; set pnpm_config_registry for registry overrides instead." }).row;
	s.write({ scope: "project:other", kind: "fact", text: `Supersedes memory #${old.id}: unrelated scope.` });

	const c = s.tidyCandidates([scope, "global"], { keepSummaries: 3 });
	const find = (type: string, id: number) => c.find((x) => x.type === type && x.drop.id === id);
	assert.equal(find("superseded", old.id)?.keep?.id, repl.id);
	assert.match(find("superseded", base.id)!.reason, /replaces part/);
	assert.equal(c.filter((x) => x.type === "old-summary").length, 1);
	assert.equal(find("similar", p1.id)?.keep?.id, p2.id);
	assert.equal(new Set(c.map((x) => x.drop.id)).size, c.length, "each row suggested once");
	assert.ok(s.get(old.id), "tidyCandidates must not delete");
	s.close();
});

test("similar prefers keeping the pinned row", () => {
	const s = newStore();
	const scope = "project:foo";
	const pinned = s.write({ scope, kind: "fact", text: "The API token lives in the system keyring under the service host.", pinned: true }).row;
	const newer = s.write({ scope, kind: "fact", text: "The API token lives in the system keyring under the service host name." }).row;
	const c = s.tidyCandidates([scope]);
	assert.equal(c[0]?.drop.id, newer.id);
	assert.equal(c[0]?.keep?.id, pinned.id);
	s.close();
});

test("extends chains become merge candidates, oldest base first", async () => {
	const { extendedIds } = await import("../extensions/recall/store.ts");
	assert.deepEqual(extendedIds("Extends pinned memories #9/#13: also drops the icon."), [9, 13]);
	const s = newStore();
	const scope = "project:foo";
	const base = s.write({ scope, kind: "gotcha", text: "Footer patch keeps colours." }).row;
	const ext = s.write({ scope, kind: "gotcha", text: `Extends pinned memory #${base.id}: also moves the usage badge.` }).row;
	const c = s.tidyCandidates([scope]).find((x) => x.type === "extends");
	assert.equal(c?.drop.id, ext.id);
	assert.equal(c?.keep?.id, base.id);
	s.close();
});

test("recallable leaves out summaries, puts pinned first, and counts all", () => {
	const s = newStore();
	s.write({ scope: "project:p", kind: "summary", text: "a compaction summary" });
	const a = s.write({ scope: "project:p", kind: "fact", text: "first fact" }).row;
	const b = s.write({ scope: "project:p", kind: "fact", text: "second fact", pinned: true }).row;
	const c = s.write({ scope: "project:p", kind: "gotcha", text: "third" }).row;
	s.write({ scope: "global", kind: "fact", text: "elsewhere" });
	const r = s.recallable("project:p", 2);
	assert.deepEqual(r.rows.map((x) => x.id), [b.id, c.id]);
	assert.equal(r.total, 3);
	assert.ok(!r.rows.some((x) => x.id === a.id));
	s.close();
});

test("match finds memories sharing distinctive words with a prompt, never summaries", () => {
	const s = newStore();
	const hit = s.write({ scope: "project:p", kind: "gotcha", text: "The sqlite busy timeout must stay at 5000 ms." }).row;
	s.write({ scope: "project:p", kind: "summary", text: "We discussed sqlite timeouts at length." });
	s.write({ scope: "project:p", kind: "fact", text: "Use pnpm, never npm." });
	s.write({ scope: "project:other", kind: "fact", text: "sqlite in another project" });
	assert.deepEqual(s.match(["project:p", "global"], "why does sqlite say busy?", 5).map((r) => r.id), [hit.id]);
	assert.deepEqual(s.match(["project:p"], "go on", 5), [], "short, common words match nothing");
	assert.deepEqual(s.match(["project:p"], "sqlite", 0), []);
	s.close();
});

test("getMany keeps the order asked for and skips missing ids", () => {
	const s = newStore();
	const a = s.write({ scope: "g", kind: "fact", text: "a" }).row;
	const b = s.write({ scope: "g", kind: "fact", text: "b" }).row;
	assert.deepEqual(s.getMany([b.id, 999, a.id]).map((r) => r.id), [b.id, a.id]);
	s.close();
});

test("tidyCandidates suggests shortening long memories, longest first, but not summaries", () => {
	const s = newStore();
	const scope = "project:p";
	const mid = s.write({ scope, kind: "fact", text: `alpha ${"x".repeat(700)}` }).row;
	const big = s.write({ scope, kind: "decision", text: `beta ${"y".repeat(1500)}` }).row;
	s.write({ scope, kind: "summary", text: "z".repeat(3000) });
	s.write({ scope, kind: "fact", text: "short" });
	const long = s.tidyCandidates([scope], { longChars: 600 }).filter((c) => c.type === "too-long");
	assert.deepEqual(long.map((c) => c.drop.id), [big.id, mid.id]);
	assert.equal(s.tidyCandidates([scope]).filter((c) => c.type === "too-long").length, 0, "off unless asked for");
	s.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigest, digestLine, type DigestOptions, firstSentence } from "../extensions/domain/digest.ts";
import type { MemoryRow } from "../extensions/domain/store.ts";

let nextId = 1;
function row(text: string, o: Partial<MemoryRow> = {}): MemoryRow {
	return { id: nextId++, scope: "project:p", kind: "fact", text, tags: [], pinned: false, createdAt: 0, updatedAt: 0, sessionId: null, ...o };
}
const opts = (o: Partial<DigestOptions> = {}): DigestOptions => ({ maxChars: 4000, maxItems: 20, globalShare: 0.5, inlineChars: 300, projectScope: "project:p", ...o });
const g = (text: string, o: Partial<MemoryRow> = {}) => row(text, { scope: "global", ...o });

test("firstSentence keeps the first sentence and cuts with an ellipsis", () => {
	assert.equal(firstSentence("Use pnpm everywhere in this repo. Never npm.", 100), "Use pnpm everywhere in this repo.");
	assert.equal(firstSentence("No full stop here at all but long", 10), "No full s…");
	assert.equal(firstSentence("Short. Then more text here.", 100), "Short. Then more text here.", "a first sentence under 20 characters is not enough");
});

test("a short memory is listed whole, a long one by its first sentence and length", () => {
	const s = digestLine(row("Use pnpm.", { id: 3, pinned: true }), 300);
	assert.deepEqual(s, { line: "#3 fact, pinned: Use pnpm.", shortened: false });
	const long = `The database lives in the data directory. ${"More detail. ".repeat(40)}`;
	const l = digestLine(row(long, { id: 4 }), 300);
	assert.equal(l.shortened, true);
	assert.match(l.line, /^#4 fact: The database lives in the data directory\. \[\d+ chars\]$/);
});

test("nothing to recall gives an empty block", () => {
	const d = buildDigest({ project: [], global: [], totals: { project: 0, global: 0 } }, opts());
	assert.equal(d.text, "");
	assert.deepEqual(d.ids, []);
});

test("pinned first (project, then global), then related, then recent; each once", () => {
	const pp = row("project pinned", { pinned: true });
	const gp = g("global pinned", { pinned: true });
	const pr = row("project recent");
	const gr = g("global recent");
	const rel = g("related to the prompt");
	const d = buildDigest({ project: [pp, pr], global: [gp, gr, rel], related: [rel, pr], totals: { project: 2, global: 3 } }, opts());
	assert.deepEqual(d.ids, [pp.id, gp.id, rel.id, pr.id, gr.id]);
	assert.equal(d.total, 5);
	assert.ok(!/more memor(y|ies) not listed/.test(d.text), "no footer when everything fits");
});

test("the budget holds, and the footer says how many were left out", () => {
	const project = Array.from({ length: 40 }, (_, i) => row(`Memory number ${i} with a few words of text to take room.`));
	const d = buildDigest({ project, global: [], totals: { project: 40, global: 0 } }, opts({ maxChars: 1000 }));
	assert.ok(d.text.length <= 1000, `${d.text.length} chars`);
	assert.ok(d.ids.length > 0 && d.ids.length < 40);
	assert.match(d.text, new RegExp(`${40 - d.ids.length} more memories not listed; use memory_search\\.$`));
});

test("maxItems caps the list", () => {
	const project = Array.from({ length: 10 }, (_, i) => row(`m${i} text`));
	assert.equal(buildDigest({ project, global: [], totals: { project: 10, global: 0 } }, opts({ maxItems: 3 })).ids.length, 3);
});

test("global memories go after the project's, and fill only what the project left", () => {
	// Related global ones come before project recent ones, so without the share they would crowd it out.
	const global = Array.from({ length: 50 }, (_, i) => g(`Global memory ${i}, with enough words to cost something real.`));
	const project = Array.from({ length: 30 }, (_, i) => row(`Project memory ${i}, also with enough words to cost something.`));
	const d = buildDigest({ project, global, related: global, totals: { project: 30, global: 50 } }, opts({ maxChars: 2000, maxItems: 100, globalShare: 0.25 }));
	const lines = d.text.split("\n");
	const globalChars = lines.filter((l) => /Global memory/.test(l)).reduce((n, l) => n + l.length + 1, 0);
	assert.ok(globalChars <= 500, `${globalChars} chars of global`);
	assert.ok(lines.filter((l) => /Project memory/.test(l)).length >= 15);

	// A project with little to say leaves the room to global memories.
	const few = buildDigest({ project: project.slice(0, 2), global, totals: { project: 2, global: 50 } }, opts({ maxChars: 2000, maxItems: 100, globalShare: 0.25 }));
	const fewGlobal = few.text.split("\n").filter((l) => /Global memory/.test(l)).length;
	assert.ok(fewGlobal > 15, `${fewGlobal} global lines`);
	assert.ok(few.text.length <= 2000);
});

test("a pinned memory that does not fit is counted and named in the footer", () => {
	const big = row("x".repeat(200), { pinned: true });
	const small = row("small one", { pinned: true });
	const d = buildDigest({ project: [big, small], global: [], totals: { project: 2, global: 0 } }, opts({ maxChars: 400, inlineChars: 300 }));
	assert.deepEqual(d.ids, [small.id], "the long line is skipped and the next one still fits");
	assert.equal(d.pinnedLeftOut, 1);
	assert.match(d.text, /1 more memory not listed, 1 pinned one among them/);
});

test("a zero budget lists nothing but still counts the pinned ones", () => {
	const d = buildDigest({ project: [row("a", { pinned: true })], global: [], totals: { project: 1, global: 0 } }, opts({ maxChars: 0 }));
	assert.equal(d.text, "");
	assert.equal(d.pinnedLeftOut, 1);
});

test("on a realistic set, recall stays within the budget and lists every pinned memory", () => {
	const longText = (n: number) => `${"A detailed memory about a tool and its configuration. ".repeat(Math.ceil(n / 54))}`.slice(0, n);
	const project = [
		...Array.from({ length: 3 }, () => row(longText(1500), { pinned: true })),
		...Array.from({ length: 25 }, (_, i) => row(longText(200 + i * 100))),
	];
	const global = [...Array.from({ length: 3 }, () => g(longText(900), { pinned: true })), ...Array.from({ length: 20 }, () => g(longText(700)))];
	const d = buildDigest({ project, global, totals: { project: project.length, global: global.length } }, opts());
	assert.ok(d.text.length <= 4000, `${d.text.length}`);
	assert.equal(d.pinnedLeftOut, 0);
	assert.ok(d.ids.length >= 15, `${d.ids.length} listed`);
});

test("pinned global memories are not held back by the global share", () => {
	const pinned = Array.from({ length: 6 }, (_, i) => g(`Pinned global ${i}, a rule that holds everywhere and matters.`, { pinned: true }));
	const project = Array.from({ length: 30 }, (_, i) => row(`Project memory ${i}, with enough words to cost something.`));
	const d = buildDigest({ project, global: pinned, totals: { project: 30, global: 6 } }, opts({ maxChars: 1500, maxItems: 100, globalShare: 0.1 }));
	for (const p of pinned) assert.ok(d.ids.includes(p.id), `pinned #${p.id} listed`);
	assert.equal(d.pinnedLeftOut, 0);
});

test("the budget holds at the boundary: lines that fit exactly are kept, one more is not", () => {
	const rows = Array.from({ length: 200 }, (_, i) => row(`m${String(i).padStart(3, "0")}`));
	for (const maxChars of [500, 501, 777, 1000, 4000]) {
		const d = buildDigest({ project: rows, global: [], totals: { project: 200, global: 0 } }, opts({ maxChars, maxItems: 200 }));
		assert.ok(d.text.length <= maxChars, `${maxChars}: ${d.text.length}`);
		assert.ok(d.ids.length > 0);
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { haloLoaded, markPlainMessage, offerToolRows, registerSidebar, type SidebarState, toolRowSpecs } from "../extensions/recall/halo.ts";

const REGISTRY = Symbol.for("pi-halo/registry");
const PENDING = Symbol.for("pi-halo/pendingToolRows");
const PLAIN = Symbol.for("halo.plainMessageTypes");
const theme = { fg: (_c: string, t: string) => t };

test("haloLoaded needs a registry with a register function", () => {
	assert.equal(haloLoaded({}), false);
	assert.equal(haloLoaded({ [REGISTRY]: {} }), false);
	assert.equal(haloLoaded({ [REGISTRY]: { register: () => {} } }), true);
});

test("every memory tool has a complete row spec", () => {
	const specs = toolRowSpecs() as Record<string, any>;
	assert.deepEqual(Object.keys(specs).sort(), ["memory_forget", "memory_get", "memory_search", "memory_update", "memory_write"]);
	for (const [name, s] of Object.entries(specs)) {
		assert.equal(typeof s.title, "string", name);
		assert.equal(typeof s.describe, "function", name);
		assert.equal(typeof s.summarize, "function", name);
		assert.deepEqual(s.icon, { nerd: "\u{F09D1}", plain: "#" });
	}
	assert.equal(specs.memory_write.summarize({ details: { id: 7, deduplicated: false, long: true } }, {}, theme, false), "#7 saved long");
	assert.equal(specs.memory_search.summarize({ details: { count: 1 } }, {}, theme, false), "1 memory");
	assert.equal(specs.memory_get.describe({ ids: [3, 4] }, "/", theme), "#3 #4");
	assert.equal(specs.memory_forget.summarize({ content: [{ type: "text", text: "No memory #9 here" }] }, {}, theme, true), "No memory #9 here");
	// Arguments still streaming in are often incomplete; nothing may throw on them.
	for (const s of Object.values(specs)) {
		assert.doesNotThrow(() => s.describe(undefined, "/", theme));
		assert.doesNotThrow(() => s.summarize({}, undefined, theme, false));
	}
});

test("with halo loaded the rows are registered under pi-recall's id", () => {
	const calls: any[] = [];
	const g = { [REGISTRY]: { register() {}, toolRowsVersion: 1, registerToolRows: (specs: any, o: any) => (calls.push({ specs, o }), () => calls.push("removed")) } };
	const remove = offerToolRows(g);
	assert.equal(calls[0].o.id, "pi-recall");
	assert.ok("memory_get" in calls[0].specs);
	remove();
	assert.equal(calls[1], "removed");
});

test("before halo loads the rows wait in its queue, and a reload replaces the earlier entry", () => {
	const g: Record<symbol, any> = {};
	offerToolRows(g);
	offerToolRows(g);
	assert.equal(g[PENDING].length, 1, "one entry per owner");
	const remove = offerToolRows(g);
	let removedByHost = false;
	g[PENDING][0].attach(() => (removedByHost = true));
	remove();
	assert.equal(removedByHost, true, "removing after halo took them calls halo's remover");
	const g2: Record<symbol, any> = {};
	const r2 = offerToolRows(g2);
	r2();
	assert.equal(g2[PENDING].length, 0, "removing before halo took them leaves the queue");
});

test("markPlainMessage adds to halo's shared set, creating it if needed", () => {
	const g: Record<symbol, any> = {};
	markPlainMessage("memory-recall", g);
	assert.ok(g[PLAIN].has("memory-recall"));
	const existing = new Set(["other"]);
	const g2: Record<symbol, any> = { [PLAIN]: existing };
	markPlainMessage("memory-recall", g2);
	assert.equal(g2[PLAIN], existing);
	assert.deepEqual([...existing], ["other", "memory-recall"]);
});

test("the sidebar registers only with halo, and shows recall size and this session's memories", async () => {
	const state: SidebarState = { recalled: 0, total: 0, chars: 0, budget: 4000, touched: [] };
	assert.equal(registerSidebar({}, {}, () => state, () => {}, {}), undefined, "no halo, no widget");

	let spec: any;
	let ctxGiven: unknown;
	const g = { [REGISTRY]: { apiVersion: 1, register: (_pi: unknown, s: any, c: unknown) => ((spec = s), (ctxGiven = c), { refresh() {}, dispose() {} }) } };
	const ctx = { hasUI: true };
	assert.ok(registerSidebar({}, ctx, () => state, () => {}, g));
	assert.equal(ctxGiven, ctx, "the session's ctx is passed so the widget starts at once");
	assert.equal(spec.id, "pi-recall");
	assert.equal(spec.sidebar, "section");
	assert.deepEqual(spec.render({}).text, "none yet");

	const row = (id: number, text: string) => ({ id, text, scope: "g", kind: "fact", tags: [], pinned: false, createdAt: 0, updatedAt: id, sessionId: null }) as any;
	Object.assign(state, { recalled: 12, total: 31, chars: 3812, touched: Array.from({ length: 10 }, (_, i) => row(i + 1, `memory ${i + 1}`)) });
	assert.equal(spec.render({}).text, "12/31 · 3.8K/4.0K");
	const lines = spec.detail({});
	assert.equal(lines.length, 9);
	assert.equal(lines[0], "#1 memory 1");
	assert.equal(lines[8], "+2 more this session");

	let shown: any;
	const reg2 = { [REGISTRY]: { apiVersion: 1, register: (_p: unknown, s: any) => ((spec = s), { refresh() {}, dispose() {} }) } };
	registerSidebar({}, ctx, () => state, (r) => void (shown = r), reg2);
	await spec.onDetailClick(1, ctx);
	assert.equal(shown.id, 2);
	await spec.onDetailClick(50, ctx);
	assert.equal(shown.id, 2, "a click past the list does nothing");
});

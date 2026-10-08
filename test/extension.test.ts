/**
 * The extension wired to a fake pi around pi's real SessionManager: recall once per context
 * (never again on reload or resume, again after compaction or on another branch), the tools as the
 * model sees them, and the halo pairing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../extensions/domain/store.ts";

const REGISTRY = Symbol.for("pi-halo/registry");
const PENDING = Symbol.for("pi-halo/pendingToolRows");
const PLAIN = Symbol.for("halo.plainMessageTypes");

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-domain-ext-"));
	for (const k of ["PI_DOMAIN_DB", "PI_CODING_AGENT_DIR"]) saved[k] = process.env[k];
	process.env.PI_DOMAIN_DB = join(dir, "domain.db");
	process.env.PI_CODING_AGENT_DIR = dir;
	const g = globalThis as Record<symbol, unknown>;
	delete g[REGISTRY];
	delete g[PENDING];
	delete g[PLAIN];
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A fake pi with a real in-memory session. */
function fakePi() {
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notes: string[] = [];
	const sm = SessionManager.inMemory(dir);
	const pi: any = {
		on: (name: string, fn: Function) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			return () => {};
		},
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (name: string, c: any) => commands.set(name, c),
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const ctx: any = {
		cwd: dir,
		hasUI: true,
		isIdle: () => true,
		ui: { notify: (m: string) => notes.push(m), confirm: async () => true, select: async () => undefined },
		sessionManager: sm,
	};
	const emit = async (name: string, event: any = {}) => {
		let out: any;
		for (const fn of handlers.get(name) ?? []) out = (await fn({ type: name, ...event }, ctx)) ?? out;
		return out;
	};
	/** A prompt as pi runs it: before_agent_start, then the user message and what the handler added. */
	const prompt = async (text: string) => {
		const r = await emit("before_agent_start", { prompt: text, systemPrompt: "", systemPromptOptions: {} });
		const userId = sm.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any);
		if (r?.message) sm.appendCustomMessageEntry(r.message.customType, r.message.content, r.message.display, r.message.details);
		return { message: r?.message, userId };
	};
	const call = async (name: string, params: any) => {
		const result = await tools.get(name).execute("id", params, undefined, undefined, ctx);
		sm.appendMessage({ role: "toolResult", toolCallId: "t", toolName: name, content: result.content, details: result.details, isError: false, timestamp: Date.now() } as any);
		return result;
	};
	const recalls = () => sm.buildContextEntries().filter((e: any) => e.type === "custom_message" && e.customType === "memory-recall").length;
	return { pi, ctx, sm, tools, commands, notes, emit, prompt, call, recalls };
}

async function load() {
	const mod = await import(`../extensions/domain/index.ts?${Math.random()}`);
	const f = fakePi();
	mod.default(f.pi);
	return f;
}

const scopeOf = () => `project:${dir.split("/").pop()}`;

function seed(texts: Array<[string, Partial<{ pinned: boolean; global: boolean; kind: string }>?]>) {
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	const ids: number[] = [];
	for (const [text, o = {}] of texts) ids.push(s.write({ scope: o.global ? "global" : scopeOf(), kind: (o.kind ?? "fact") as any, text, pinned: o.pinned }).row.id);
	s.close();
	return ids;
}

test("recall comes with the first prompt, once; a reload or resume does not add another", async () => {
	seed([["Use pnpm, never npm.", { pinned: true }], ["The build is tsc.", {}], ["A summary of a long session.", { kind: "summary" }]]);
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const { message: first } = await f.prompt("hello");
	assert.ok(first, "recall on the first prompt");
	assert.equal(first.customType, "memory-recall");
	assert.match(first.content, /Use pnpm, never npm\./);
	assert.ok(!first.content.includes("summary of a long session"), "summaries are never recalled");
	assert.deepEqual({ count: first.details.count, total: first.details.total }, { count: 2, total: 2 });

	assert.equal((await f.prompt("and again")).message, undefined, "not on later prompts");
	for (const reason of ["reload", "resume"]) {
		await f.emit("session_start", { reason });
		assert.equal((await f.prompt(`after ${reason}`)).message, undefined, `not after ${reason}`);
	}
	assert.equal(f.recalls(), 1);
});

test("a recall left by an older version counts as present", async () => {
	seed([["A fact.", {}]]);
	const f = await load();
	f.sm.appendCustomMessageEntry("memory-recall", "old recall", true, { count: 7 });
	await f.emit("session_start", { reason: "resume" });
	assert.equal((await f.prompt("hi")).message, undefined);
	f.sm.appendCustomMessageEntry("memory-recall", "older still", true, undefined);
	assert.equal((await f.prompt("hi")).message, undefined);
});

test("after compaction summarises the recall away, the next prompt recalls again", async () => {
	seed([["A fact.", {}]]);
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	await f.prompt("one");
	const { userId } = await f.prompt("two");
	f.sm.appendCompaction("summary of one", userId, 1000);
	await f.emit("session_compact", { compactionEntry: { summary: "summary of one" }, reason: "threshold" });
	assert.equal(f.recalls(), 0);
	assert.ok((await f.prompt("three")).message);
	assert.equal(f.recalls(), 1);
});

test("a compaction that keeps the recall does not repeat it", async () => {
	seed([["A fact.", {}]]);
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const { userId } = await f.prompt("one");
	f.sm.appendCompaction("summary", userId, 1000);
	await f.emit("session_compact", { compactionEntry: { summary: "summary" }, reason: "threshold" });
	assert.equal((await f.prompt("two")).message, undefined);
});

test("moving to a branch without the recall brings one on the next prompt", async () => {
	seed([["A fact.", {}]]);
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const root = f.sm.appendMessage({ role: "user", content: "before", timestamp: 1 } as any);
	await f.prompt("one");
	f.sm.branch(root);
	await f.emit("session_tree", { newLeafId: root, oldLeafId: null });
	assert.equal(f.recalls(), 0);
	assert.ok((await f.prompt("other way")).message);
});

test("an empty recall is worked out once, and its notice given once", async () => {
	seed([["x".repeat(2000), { pinned: true }]]);
	writeFileSync(join(dir, "pi-domain.json"), JSON.stringify({ recall: { maxChars: 500, inlineChars: 10_000 } }));
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.equal((await f.prompt("one")).message, undefined);
	assert.equal((await f.prompt("two")).message, undefined);
	assert.equal(f.notes.filter((n) => /do(es)? not fit the recall budget/.test(n)).length, 1);
});

test("an empty database recalls nothing", async () => {
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.equal((await f.prompt("hi")).message, undefined);
});

test("the recall budget from pi-domain.json is respected", async () => {
	seed(Array.from({ length: 60 }, (_, i) => [`Memory ${i}: ${"some words ".repeat(20)}`, {}] as [string, {}]));
	writeFileSync(join(dir, "pi-domain.json"), JSON.stringify({ recall: { maxChars: 1500 } }));
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const { message } = await f.prompt("hi");
	assert.ok(message.content.length <= 1500, `${message.content.length}`);
	assert.match(message.content, /more memories not listed/);
});

test("a memory matching the first prompt is listed even when it is not recent", async () => {
	seed([["The flaky widget test needs TZ=UTC to pass.", {}], ...Array.from({ length: 40 }, (_, i) => [`Unrelated note ${i} ${"filler ".repeat(30)}`, {}] as [string, {}])]);
	writeFileSync(join(dir, "pi-domain.json"), JSON.stringify({ recall: { maxChars: 1200 } }));
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.match((await f.prompt("the widget test is flaky again")).message.content, /TZ=UTC/);
});

test("prompts full of search syntax do not break recall", async () => {
	seed([["A fact about package.json scripts.", {}]]);
	for (const p of ['NEAR AND OR "x* ^col: ____ -- ((', "package.json", "src/foo.ts node-sqlite", ""]) {
		const f = await load();
		await f.emit("session_start", { reason: "startup" });
		assert.ok((await f.prompt(p)).message, JSON.stringify(p));
	}
});

test("write warns on long text; search shortens; get gives it in full", async () => {
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const long = `The deploy needs three steps. ${"Detail about the deploy. ".repeat(40)}`;
	const w = await f.call("memory_write", { text: long, kind: "fact" });
	assert.equal(w.details.long, true);
	assert.match(w.content[0].text, /Note: this memory is \d+ characters/);
	const short = await f.call("memory_write", { text: "Short one about deploy.", kind: "fact" });
	assert.equal(short.details.long, false);

	const s = await f.call("memory_search", { query: "deploy" });
	assert.match(s.content[0].text, /The deploy needs three steps\. \[\d+ chars\]/);
	assert.ok(s.content[0].text.length < 600, "search does not return the long text");
	assert.deepEqual(s.details.ids.sort(), [w.details.id, short.details.id].sort());

	const g = await f.call("memory_get", { ids: [w.details.id, w.details.id, 999] });
	assert.ok(g.content[0].text.includes(long));
	assert.match(g.content[0].text, /Not found here: #999/);
	assert.ok(!/Only the first/.test(g.content[0].text), "a repeated id is not counted twice");
	assert.deepEqual(g.details.ids, [w.details.id]);
});

test("memory_get stays under its size cap and names exactly what it returned", async () => {
	const ids = seed([
		["a".repeat(9000), {}],
		["b".repeat(9000), {}],
		["small", {}],
	]);
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const g = await f.call("memory_get", { ids });
	assert.deepEqual(g.details.ids, [ids[0], ids[2]], "the one that did not fit is skipped, the small one after it kept");
	assert.match(g.content[0].text, /1 memory left out/);
});

test("another project's memories cannot be read, changed or deleted", async () => {
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	const other = s.write({ scope: "project:elsewhere", kind: "fact", text: "secret of another project" }).row;
	s.close();
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.ok(!(await f.call("memory_get", { ids: [other.id] })).content[0].text.includes("secret"));
	await assert.rejects(() => f.call("memory_update", { id: other.id, text: "changed" }), /No memory/);
	await assert.rejects(() => f.call("memory_forget", { id: other.id, reason: "x" }), /No memory/);
	const check = new MemoryStore(process.env.PI_DOMAIN_DB!);
	assert.equal(check.get(other.id)?.text, "secret of another project");
	check.close();
});

test("the tools carry hints for permission extensions", async () => {
	const f = await load();
	assert.equal(f.tools.get("memory_search").annotations.readOnlyHint, true);
	assert.equal(f.tools.get("memory_get").annotations.readOnlyHint, true);
	assert.equal(f.tools.get("memory_forget").annotations.destructiveHint, true);
	assert.equal(f.tools.get("memory_write").annotations.destructiveHint, false);
});

test("what the tools cost in every request stays small", async () => {
	const f = await load();
	let total = 0;
	for (const t of f.tools.values()) {
		total += JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
		total += (t.promptSnippet?.length ?? 0) + (t.promptGuidelines ?? []).join("\n").length;
	}
	// 3227 characters for four tools before this was trimmed; five tools now.
	assert.ok(total < 3000, `${total} characters`);
});

test("without halo: no widget, rows queued for halo, the recall type marked plain", async () => {
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const g = globalThis as Record<symbol, any>;
	assert.equal(g[PENDING]?.length, 1);
	assert.equal(g[PENDING][0].id, "pi-domain");
	assert.ok(g[PLAIN].has("memory-recall"));
});

test("with halo: the sidebar follows recall, this session's memories, resume and branch moves", async () => {
	seed([["A fact.", {}], ["Another.", { global: true }]]);
	let spec: any;
	let refreshed = 0;
	(globalThis as Record<symbol, any>)[REGISTRY] = {
		apiVersion: 1,
		register: (_pi: unknown, s: any) => ((spec = s), { refresh: () => refreshed++, dispose() {} }),
		toolRowsVersion: 1,
		registerToolRows: () => () => {},
	};
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.equal(spec.id, "pi-domain");
	const root = f.sm.appendMessage({ role: "user", content: "start", timestamp: 1 } as any);
	await f.prompt("hi");
	assert.match(spec.render({}).text, /^2\/2 · /);
	const w = await f.call("memory_write", { text: "Saved now.", kind: "decision" });
	assert.ok(refreshed > 0);
	assert.deepEqual(spec.detail({}), [`#${w.details.id} Saved now.`]);

	await f.emit("session_start", { reason: "resume" });
	assert.deepEqual(spec.detail({}), [`#${w.details.id} Saved now.`], "rebuilt from the session");
	assert.match(spec.render({}).text, /^2\/2 · /, "recall numbers from the recall message");

	f.sm.branch(root);
	await f.emit("session_tree", { newLeafId: root, oldLeafId: null });
	assert.deepEqual(spec.detail({}), [], "another branch has its own memories");
	assert.equal(spec.render({}).text, "none yet", "nothing recalled on that branch yet");
});

test("a malformed settings file is reported and the defaults used", async () => {
	writeFileSync(join(dir, "pi-domain.json"), "{nope");
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	assert.ok(f.notes.some((n) => /ignoring .*pi-domain\.json/.test(n)));
});

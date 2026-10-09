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
	// 3227 characters for four tools before this was trimmed; five tools and a project argument now.
	assert.ok(total < 3400, `${total} characters`);
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

// ------------------------------------------------------------------ work done for another project

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/** A fake pi whose session starts in `cwd` (the shared fake uses the temp dir itself). */
async function loadIn(cwd: string) {
	const mod = await import(`../extensions/domain/index.ts?${Math.random()}`);
	const f = fakePi();
	f.ctx.cwd = cwd;
	mod.default(f.pi);
	return f;
}

function repoAt(path: string) {
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: path });
}

test("from a plain folder, a memory can be filed under another project, by name or by directory", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	repoAt(join(dir, "git", "kiln"));
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	s.write({ scope: "project:kiln", kind: "fact", text: "Existing kiln fact." });
	s.close();
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });

	const byName = await f.call("memory_write", { text: "Kiln retries three times.", kind: "decision", project: "kiln" });
	assert.equal(byName.details.scope, "project:kiln");
	assert.match(byName.content[0].text, /Filed under project:kiln, not this folder's project\./);

	const byPath = await f.call("memory_write", { text: "A new project's first memory.", kind: "fact", project: join(dir, "git", "kiln") });
	assert.equal(byPath.details.scope, "project:kiln");

	const here = await f.call("memory_write", { text: "A note about the home folder.", kind: "fact" });
	assert.equal(here.details.scope, `project:${home.split("/").pop()}`);
	assert.ok(!/Filed under/.test(here.content[0].text), "no note when it went where the folder says");

	const g = await f.call("memory_write", { text: "Applies everywhere.", kind: "fact", global: true });
	assert.equal(g.details.scope, "global");
	assert.ok(!/Filed under/.test(g.content[0].text));
});

test("a typo in project is refused and nothing is written", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	s.write({ scope: "project:kiln", kind: "fact", text: "Existing kiln fact." });
	s.close();
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });
	await assert.rejects(() => f.call("memory_write", { text: "Typo.", kind: "fact", project: "kilm" }), /no project named kilm has memories \(known: kiln\)/);
	await assert.rejects(() => f.call("memory_write", { text: "Both.", kind: "fact", project: "kiln", global: true }), /either global or project/);
	const check = new MemoryStore(process.env.PI_DOMAIN_DB!);
	assert.deepEqual(check.scopes(), ["project:kiln"], "no new scope appeared");
	check.close();
});

test("project reads, moves and deletes work across projects, and still refuse other projects' ids without it", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	const k = s.write({ scope: "project:kiln", kind: "fact", text: "Kiln runs jobs in containers by default." }).row;
	const h = s.write({ scope: `project:${home.split("/").pop()}`, kind: "fact", text: "Misfiled: kiln needs a retry policy." }).row;
	s.close();
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });

	// without project: kiln's memory is out of reach
	await assert.rejects(() => f.call("memory_update", { id: k.id, text: "changed" }), /No memory/);
	assert.ok(!(await f.call("memory_search", { query: "containers" })).content[0].text.includes("containers"));
	assert.ok(!(await f.call("memory_get", { ids: [k.id] })).content[0].text.includes("containers"));

	// with project: it can be read and changed
	assert.match((await f.call("memory_search", { query: "containers", project: "kiln" })).content[0].text, /containers/);
	assert.match((await f.call("memory_get", { ids: [k.id], project: "kiln" })).content[0].text, /containers/);
	const upd = await f.call("memory_update", { id: k.id, text: "Kiln runs jobs in containers, strong isolation when policy says.", in: "kiln" });
	assert.equal(upd.details.scope, "project:kiln");
	assert.ok(!/Moved from/.test(upd.content[0].text), "editing a memory in another project does not move it");

	// the project it is in now is "in"; naming "project" is a move
	const stay = await f.call("memory_update", { id: k.id, pinned: true, in: "kiln" });
	assert.equal(stay.details.scope, "project:kiln");
	assert.ok(!/Moved from/.test(stay.content[0].text));

	// moving a memory into the project it is about
	const mv = await f.call("memory_update", { id: h.id, project: "kiln" });
	assert.equal(mv.details.scope, "project:kiln");
	assert.match(mv.content[0].text, /Moved from project:home to project:kiln\./);

	// deleting across projects is still confirmed by the user
	const del = await f.call("memory_forget", { id: k.id, reason: "test", project: "kiln" });
	assert.equal(del.details.deleted, true);
});

test("the project argument adds little to what the tools cost", async () => {
	const f = await load();
	let total = 0;
	for (const t of f.tools.values()) {
		total += JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
		total += (t.promptSnippet?.length ?? 0) + (t.promptGuidelines ?? []).join("\n").length;
	}
	assert.ok(total < 3400, `${total} characters`);
});

test("/memory-tidy offers to move misfiled memories, and 'all' reaches every project", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	repoAt(join(dir, "git", "kiln"));
	process.env.PI_DOMAIN_REPOS = join(dir, "git");
	try {
		const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
		const homeScope = `project:${home.split("/").pop()}`;
		const mis = s.write({ scope: homeScope, kind: "decision", text: "The executor contract is in ~/git/kiln/docs." }).row;
		const generic = s.write({ scope: homeScope, kind: "fact", text: "Keybindings need no Shift." }).row;
		const other = s.write({ scope: "project:elsewhere", kind: "decision", text: "Another thing about kiln here." }).row;
		s.close();
		const f = await loadIn(home);
		await f.emit("session_start", { reason: "startup" });
		const prompts: Array<{ title: string; opts: string[] }> = [];
		f.ctx.ui.select = async (title: string, opts: string[]) => (prompts.push({ title, opts }), opts[0]);

		await f.commands.get("memory-tidy").handler("", f.ctx);
		assert.equal(prompts.length, 1, "only the misfiled one, nothing else to suggest");
		assert.match(prompts[0]!.title, /\(misfiled\)/);
		assert.deepEqual(prompts[0]!.opts, ["Move to project:kiln", "Make global", "Keep here", "Stop"]);
		const after = new MemoryStore(process.env.PI_DOMAIN_DB!);
		assert.equal(after.get(mis.id)!.scope, "project:kiln");
		assert.equal(after.get(generic.id)!.scope, homeScope, "a memory that names no project stays");
		assert.equal(after.get(other.id)!.scope, "project:elsewhere", "other projects are not touched without 'all'");
		assert.ok(f.notes.some((n) => /moved 1/.test(n)));

		// 'all' looks at every project
		const s2 = new MemoryStore(process.env.PI_DOMAIN_DB!);
		const mis2 = s2.write({ scope: "project:elsewhere", kind: "fact", text: "Run it from ~/git/kiln first." }).row;
		s2.close();
		prompts.length = 0;
		await f.commands.get("memory-tidy").handler("all", f.ctx);
		const check = new MemoryStore(process.env.PI_DOMAIN_DB!);
		assert.equal(check.get(mis2.id)!.scope, "project:kiln");
		assert.ok(f.notes.some((n) => /every project/.test(n)));
		check.close();
		after.close();
	} finally {
		delete process.env.PI_DOMAIN_REPOS;
	}
});

test("/memory-tidy: a memory in a real repository's scope is never called misfiled", async () => {
	repoAt(join(dir, "git", "kiln"));
	repoAt(join(dir, "git", "tools"));
	process.env.PI_DOMAIN_REPOS = join(dir, "git");
	try {
		const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
		s.write({ scope: "project:tools", kind: "fact", text: "Compare with ~/git/kiln when changing this." });
		s.close();
		const f = await loadIn(join(dir, "git", "tools"));
		await f.emit("session_start", { reason: "startup" });
		await f.commands.get("memory-tidy").handler("", f.ctx);
		assert.ok(f.notes.some((n) => /Nothing to tidy/.test(n)));
	} finally {
		delete process.env.PI_DOMAIN_REPOS;
	}
});

test("memory_update: project and global together are refused, a text edit with only 'in' never moves, a clash is reported", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const homeScope = `project:${home.split("/").pop()}`;
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	const mine = s.write({ scope: homeScope, kind: "fact", text: "Same words in two places." }).row;
	s.write({ scope: "project:kiln", kind: "fact", text: "Same words in two places." });
	const g = s.write({ scope: "global", kind: "fact", text: "A global one." }).row;
	s.close();
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });
	await assert.rejects(() => f.call("memory_update", { id: mine.id, global: true, project: "kiln" }), /either global or project/);
	// moving into a project that already holds the same text is refused and leaves the memory where it was
	await assert.rejects(() => f.call("memory_update", { id: mine.id, project: "kiln" }), /already has that text/);
	const after = new MemoryStore(process.env.PI_DOMAIN_DB!);
	assert.equal(after.get(mine.id)!.scope, homeScope);
	after.close();
	// a global memory edited with a project named for context stays global
	const edit = await f.call("memory_update", { id: g.id, pinned: true, in: "kiln" });
	assert.equal(edit.details.scope, "global");
});

test("a project named for reading still includes the folder's own project", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const homeScope = `project:${home.split("/").pop()}`;
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	const mine = s.write({ scope: homeScope, kind: "fact", text: "A memory in the home folder." }).row;
	s.write({ scope: "project:kiln", kind: "fact", text: "A kiln memory." });
	s.close();
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });
	const got = await f.call("memory_get", { ids: [mine.id], project: "kiln" });
	assert.deepEqual(got.details.ids, [mine.id]);
	const found = await f.call("memory_search", { query: "memory", project: "kiln" });
	assert.equal(found.details.count, 2);
});

test("the long flag follows the length note only, not the words in a scope name", async () => {
	const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
	s.write({ scope: "project:characters", kind: "fact", text: "Seed." });
	s.close();
	const f = await load();
	await f.emit("session_start", { reason: "startup" });
	const w = await f.call("memory_write", { text: "Short one.", kind: "fact", project: "characters" });
	assert.equal(w.details.long, false);
	assert.match(w.content[0].text, /Filed under project:characters/);
});

test("/memory-tidy looks at every row, however many there are, and numbers only what it shows", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	repoAt(join(dir, "git", "kiln"));
	process.env.PI_DOMAIN_REPOS = join(dir, "git");
	try {
		const homeScope = `project:${home.split("/").pop()}`;
		const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
		// 250 newer global rows would have crowded a 200-row search
		const kinds = ["fact", "decision", "gotcha", "preference"] as const;
		for (let i = 0; i < 250; i++) s.write({ scope: "global", kind: kinds[i % 4]!, text: `Unique-${i.toString(36)}-${(i * 7919).toString(36)}-${(i * 104729).toString(36)}` });
		const oldest = s.write({ scope: homeScope, kind: "fact", text: "Old note: see ~/git/kiln." }).row;
		s.close();
		const f = await loadIn(home);
		await f.emit("session_start", { reason: "startup" });
		const titles: string[] = [];
		f.ctx.ui.select = async (title: string, opts: string[]) => (titles.push(title), opts[0]);
		await f.commands.get("memory-tidy").handler("", f.ctx);
		assert.equal(titles.length, 1);
		assert.match(titles[0]!, /^Memory tidy 1\/1 \(misfiled\)/);
		const after = new MemoryStore(process.env.PI_DOMAIN_DB!);
		assert.equal(after.get(oldest.id)!.scope, "project:kiln");
		after.close();
	} finally {
		delete process.env.PI_DOMAIN_REPOS;
	}
});

test("/memory-tidy: Stop ends the pass; without a UI it only lists", async () => {
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	repoAt(join(dir, "git", "kiln"));
	process.env.PI_DOMAIN_REPOS = join(dir, "git");
	try {
		const homeScope = `project:${home.split("/").pop()}`;
		const s = new MemoryStore(process.env.PI_DOMAIN_DB!);
		const a = s.write({ scope: homeScope, kind: "fact", text: "First: see ~/git/kiln." }).row;
		const b = s.write({ scope: homeScope, kind: "fact", text: "Second: see ~/git/kiln too." }).row;
		s.close();
		const f = await loadIn(home);
		await f.emit("session_start", { reason: "startup" });
		let asked = 0;
		f.ctx.ui.select = async (_t: string, opts: string[]) => (asked++, opts[opts.length - 1]); // "Stop"
		await f.commands.get("memory-tidy").handler("", f.ctx);
		assert.equal(asked, 1, "stopped after the first prompt");
		const check = new MemoryStore(process.env.PI_DOMAIN_DB!);
		assert.equal(check.get(a.id)!.scope, homeScope);
		assert.equal(check.get(b.id)!.scope, homeScope);
		check.close();

		const lines: string[] = [];
		const log = console.log;
		console.log = (m: string) => lines.push(String(m));
		try {
			f.ctx.hasUI = false;
			await f.commands.get("memory-tidy").handler("", f.ctx);
		} finally {
			console.log = log;
		}
		assert.match(lines.join("\n"), /2 suggestions .*2 misfiled/);
		assert.match(lines.join("\n"), new RegExp(`misfiled #${a.id}: ${homeScope} -> project:kiln`));
		const again = new MemoryStore(process.env.PI_DOMAIN_DB!);
		assert.equal(again.get(a.id)!.scope, homeScope, "nothing changed without a UI");
		again.close();
	} finally {
		delete process.env.PI_DOMAIN_REPOS;
	}
});

test("a relative or symlinked project path files under the repository's own name", async () => {
	const { symlinkSync } = await import("node:fs");
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	repoAt(join(dir, "git", "kiln"));
	symlinkSync(join(dir, "git", "kiln"), join(dir, "k"));
	const f = await loadIn(home);
	await f.emit("session_start", { reason: "startup" });
	assert.equal((await f.call("memory_write", { text: "Via a symlink.", kind: "fact", project: join(dir, "k") })).details.scope, "project:kiln");
	assert.equal((await f.call("memory_write", { text: "Via a relative path.", kind: "fact", project: "../git/kiln" })).details.scope, "project:kiln");
});

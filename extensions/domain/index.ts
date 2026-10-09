/**
 * pi-domain: persistent memory for pi, in a local SQLite database.
 *
 *  - Tools for the model: memory_write, memory_update, memory_search, memory_get and
 *    memory_forget (each deletion confirmed by the user).
 *  - Recall: with the first prompt of a session (and again after compaction drops it), the model
 *    gets a short index of memories within a character budget: pinned ones, ones related to the
 *    prompt, then recent ones. Long memories are listed by their first sentence; memory_get gives
 *    the rest.
 *  - With summaries.save on, compaction summaries are kept as searchable notes; a snapshot of the
 *    database is taken daily.
 *  - Commands: /memory, /memory-forget, /memory-pin, /memory-tidy, /memory-backup, /memory-restore.
 *  - With pi-halo loaded: halo-styled tool rows and a sidebar section (see halo.ts). Optional.
 *
 * Memories are scoped per git repository with a shared `global` scope (scope.ts). The database is
 * ~/.local/share/pi-domain/domain.db (paths.ts); settings are in pi-domain.json (settings.ts).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { autoBackup, backupDb } from "./backup.ts";
import { buildDigest } from "./digest.ts";
import { compactChars, formatRow, formatSearchRow, lengthNote, memories } from "./format.ts";
import { haloLoaded, markPlainMessage, offerToolRows, registerSidebar, type SidebarState } from "./halo.ts";
import { backupDirFor, type DbLocation, resolveDb } from "./paths.ts";
import { recallRenderer } from "./recall-row.ts";
import { findSnapshot, listSnapshots, restoreSnapshot, snapshotLabel } from "./restore.ts";
import { defaultRepoRoots, findRepos, GLOBAL_SCOPE, isInGitRepo, resolveProject, resolveProjectScope, resolveReadScopes } from "./scope.ts";
import { findMisfiled } from "./misfiled.ts";
import { DEFAULT_SETTINGS, loadSettings, type RecallSettings, settingsPath } from "./settings.ts";
import { MEMORY_KINDS, type MemoryKind, type MemoryRow, MemoryStore } from "./store.ts";

const RECALL_TYPE = "memory-recall";
/** Search results returned to the model by default, and at most. */
const SEARCH_LIMIT = 10;
const SEARCH_MAX = 30;
/** memory_get: ids per call, and characters returned in all. */
const GET_MAX_IDS = 20;
const GET_MAX_CHARS = 16_000;
/** Memories related to the first prompt that recall may list. */
const RELATED_LIMIT = 5;

type RecallDetails = { count: number; total: number; chars: number; ids: number[] };

// ------------------------------------------------------------------ renderers (without pi-halo)
// With halo loaded, halo draws these tools from the specs in halo.ts instead.

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function callLine(verb: string, detail: string, theme: any) {
	return new Text(`${theme.fg("toolTitle", theme.bold(verb))}${detail ? ` ${theme.fg("muted", detail)}` : ""}`, 0, 0);
}

/** memory_write / memory_update: id, kind and the start of the text; the full result when expanded. */
function writeRenderers(verb: string) {
	return {
		renderCall(args: { id?: number; kind?: string }, theme: any) {
			return callLine(verb, args.id !== undefined ? `#${args.id}` : (args.kind ?? "memory"), theme);
		},
		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
			if (isPartial) return new Text(theme.fg("dim", "saving…"), 0, 0);
			const full = String(result.content?.[0]?.text ?? "");
			if (expanded) return new Text(theme.fg("toolOutput", full), 0, 0);
			const m = full.match(/#(\d+) \[(\w+)\](?: \[pinned\])? ([^\n]*)/);
			const head = m ? `#${m[1]} ${m[2]}` : "done";
			const preview = m ? short(oneLine(m[3]!).replace(/ \([^)]*\)$/, ""), 40) : "";
			const warn = result.details?.long ? ` ${theme.fg("warning", "long")}` : "";
			return new Text(`${theme.fg("success", head)}${preview ? ` ${theme.fg("dim", preview)}` : ""}${warn}`, 0, 0);
		},
	};
}

/** memory_search / memory_get: "N memories #1 #2 …"; the full list when expanded. */
function listRenderers(verb: string, describe: (args: any) => string) {
	return {
		renderCall(args: any, theme: any) {
			return callLine(verb, describe(args), theme);
		},
		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
			if (isPartial) return new Text(theme.fg("dim", "reading…"), 0, 0);
			const full = String(result.content?.[0]?.text ?? "");
			if (expanded) return new Text(theme.fg("toolOutput", full), 0, 0);
			const ids: number[] = result.details?.ids ?? [];
			if (!ids.length) return new Text(theme.fg("dim", "no matches"), 0, 0);
			const shown = ids.slice(0, 8).map((i) => `#${i}`).join(" ");
			const more = ids.length > 8 ? ` +${ids.length - 8}` : "";
			return new Text(`${theme.fg("success", memories(ids.length))} ${theme.fg("dim", `${shown}${more}`)}`, 0, 0);
		},
	};
}

const forgetRenderers = {
	renderCall(args: { id?: number; reason?: string }, theme: any) {
		return callLine("Forget memory", `${args.id !== undefined ? `#${args.id}` : ""}${args.reason ? ` ${short(args.reason, 40)}` : ""}`, theme);
	},
	renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
		if (isPartial) return new Text(theme.fg("dim", "waiting for confirmation…"), 0, 0);
		if (expanded) return new Text(theme.fg("toolOutput", String(result.content?.[0]?.text ?? "")), 0, 0);
		return new Text(result.details?.deleted ? theme.fg("success", "deleted") : theme.fg("warning", "kept"), 0, 0);
	},
};

// ------------------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	// Opened lazily: the factory also runs in invocations that never start a session, and holding
	// a file handle then would leak.
	let store: MemoryStore | undefined;
	let where: DbLocation | undefined;
	let settings: RecallSettings = DEFAULT_SETTINGS;
	let sidebar: { refresh(): void; dispose(): void } | undefined;
	const side: SidebarState = { recalled: 0, total: 0, chars: 0, budget: DEFAULT_SETTINGS.recall.maxChars, touched: [] };

	const location = (): DbLocation => (where ??= resolveDb());
	const openStore = (): MemoryStore => (store ??= new MemoryStore(location().path));

	/**
	 * The scope a project argument names, for work done from a folder that is not the project.
	 * Throws with the reason when it names nothing real, so a typo never starts a new scope.
	 */
	function projectScope(ctx: ExtensionContext, project: string): string {
		const r = resolveProject(project, ctx.cwd, openStore().scopes());
		if ("error" in r) throw new Error(r.error);
		return r.scope;
	}

	/** Where a write goes: global, the named project, or the project of the current folder. */
	function writeScope(ctx: ExtensionContext, global: boolean | undefined, project?: string): string {
		if (global && project) throw new Error("pass either global or project, not both");
		if (global) return GLOBAL_SCOPE;
		return project ? projectScope(ctx, project) : resolveProjectScope(ctx.cwd);
	}

	/** Scopes a read covers: this folder's project and global, plus the named project when there is one. */
	function readScopes(ctx: ExtensionContext, project?: string): string[] {
		const own = resolveReadScopes(ctx.cwd);
		return project ? [...new Set([projectScope(ctx, project), ...own])] : own;
	}

	/**
	 * A memory the session may see, or an error. That is this folder's project and global, plus the
	 * named project when there is one (so a memory can be reached in another project, or moved from
	 * this folder's project into it).
	 */
	function readable(ctx: ExtensionContext, id: number, project?: string): MemoryRow {
		const row = openStore().get(id);
		const scopes = readScopes(ctx, project);
		if (!row || !scopes.includes(row.scope)) throw new Error(`No memory #${id} in ${scopes.join(" or ")}`);
		return row;
	}

	/** A note for the model when it saved into a project other than the folder's: where it went. */
	function whereNote(ctx: ExtensionContext, scope: string): string {
		return scope === GLOBAL_SCOPE || scope === resolveProjectScope(ctx.cwd) ? "" : `\nFiled under ${scope}, not this folder's project.`;
	}

	/** The optional project argument shared by the tools: a project that is not this folder's. */
	const projectArg = () => Type.Optional(Type.String({ description: "Another project: name or directory" }));

	function touch(row: MemoryRow) {
		side.touched = [row, ...side.touched.filter((r) => r.id !== row.id)];
		sidebar?.refresh();
	}

	// halo (optional): its rows for the memory tools, and the recall row drawn without a panel.
	offerToolRows();
	markPlainMessage(RECALL_TYPE);

	// ------------------------------------------------------------------------- tools

	pi.registerTool({
		name: "memory_write",
		label: "Remember",
		...writeRenderers("Remember"),
		description:
			"Save a memory that persists across sessions: a decision, preference, fact or gotcha. " +
			"Project scope by default; global for facts that hold everywhere. Pinned memories are always recalled.",
		promptSnippet: "memory_write: save a decision, preference, fact or gotcha for later sessions",
		promptGuidelines: [
			"Save memories for durable decisions, preferences and gotchas, not task progress. One point per memory, key point first, readable out of context.",
			"If a memory is about another project than this folder's, set project.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The memory: one point, key point first." }),
			kind: StringEnum(MEMORY_KINDS),
			tags: Type.Optional(Type.Array(Type.String())),
			pinned: Type.Optional(Type.Boolean({ description: "Always recall it." })),
			global: Type.Optional(Type.Boolean({ description: "For every project." })),
			project: projectArg(),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		// Writes share the connection; one at a time keeps the duplicate check honest.
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = openStore().write({
				scope: writeScope(ctx, params.global, params.project),
				kind: params.kind as MemoryKind,
				text: params.text,
				tags: params.tags,
				pinned: params.pinned,
				sessionId: ctx.sessionManager.getSessionId() ?? null,
			});
			touch(result.row);
			const lenNote = lengthNote(params.text, settings.write.warnChars, settings.recall.inlineChars);
			const note = lenNote + whereNote(ctx, result.row.scope);
			const verb = result.deduplicated ? "Refreshed existing memory" : "Saved memory";
			return {
				content: [{ type: "text", text: `${verb} ${formatRow(result.row)}${note}` }],
				details: { id: result.row.id, scope: result.row.scope, deduplicated: result.deduplicated, long: lenNote !== "" },
			};
		},
	});

	pi.registerTool({
		name: "memory_update",
		label: "Revise memory",
		...writeRenderers("Revise memory"),
		description: "Change a memory by id: its text, kind, tags, pin. To move it, set global or project. Prefer this to saving a correcting memory.",
		promptSnippet: "memory_update: revise a memory by id when it is wrong or incomplete",
		parameters: Type.Object({
			id: Type.Number(),
			text: Type.Optional(Type.String()),
			kind: Type.Optional(StringEnum(MEMORY_KINDS)),
			tags: Type.Optional(Type.Array(Type.String())),
			pinned: Type.Optional(Type.Boolean()),
			global: Type.Optional(Type.Boolean({ description: "true: move to global; false: to this folder's project." })),
			project: Type.Optional(Type.String({ description: "Move it to this project" })),
			in: Type.Optional(Type.String({ description: "Project it is in now" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// "project" moves the memory; "in" only says where it is now, so reaching a memory in
			// another project never relocates it by accident.
			if (params.global !== undefined && params.project) throw new Error("pass either global or project, not both");
			const row = readable(ctx, params.id, params.in ?? params.project);
			const moveTo = params.global === true ? GLOBAL_SCOPE : params.project ? projectScope(ctx, params.project) : params.global === false ? resolveProjectScope(ctx.cwd) : undefined;
			const updated = openStore().update(params.id, {
				text: params.text,
				kind: params.kind as MemoryKind | undefined,
				tags: params.tags,
				pinned: params.pinned,
				scope: moveTo && moveTo !== row.scope ? moveTo : undefined,
			})!;
			touch(updated);
			const moved = updated.scope !== row.scope ? `\nMoved from ${row.scope} to ${updated.scope}.` : "";
			const lenNote = params.text ? lengthNote(params.text, settings.write.warnChars, settings.recall.inlineChars) : "";
			const note = lenNote + moved;
			return {
				content: [{ type: "text", text: `Updated memory ${formatRow(updated)}${note}` }],
				details: { id: updated.id, scope: updated.scope, long: lenNote !== "" },
			};
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Forget memory",
		...forgetRenderers,
		description: "Delete a memory by id, e.g. after merging it into another. The user confirms each deletion.",
		promptSnippet: "memory_forget: delete a memory by id (the user confirms)",
		parameters: Type.Object({
			id: Type.Number(),
			reason: Type.String({ description: "Shown to the user, e.g. 'merged into #9'." }),
			project: projectArg(),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const row = readable(ctx, params.id, params.project);
			// Deletion cannot be undone (short of a restore): a person confirms every one.
			const ok = ctx.hasUI ? await ctx.ui.confirm(`Delete memory #${row.id}? (${params.reason})`, formatRow(row)) : false;
			if (!ok) {
				return {
					content: [{ type: "text", text: `Kept memory #${row.id}: the user declined (or there is no UI to confirm).` }],
					details: { id: row.id, deleted: false },
				};
			}
			openStore().forget(row.id);
			side.touched = side.touched.filter((r) => r.id !== row.id);
			sidebar?.refresh();
			return { content: [{ type: "text", text: `Deleted memory #${row.id}.` }], details: { id: row.id, deleted: true } };
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Recall",
		...listRenderers("Recall", (a) => (a?.query ? `"${short(String(a.query), 40)}"` : "recent")),
		description:
			"Search memories from earlier sessions (this project and global). Long results are shortened; memory_get gives full text. " +
			"Use before asking the user something they may have told you before.",
		promptSnippet: "memory_search: find decisions, preferences and facts from earlier sessions",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words to look for. Omit for the most recent." })),
			kinds: Type.Optional(Type.Array(StringEnum(MEMORY_KINDS))),
			limit: Type.Optional(Type.Number({ description: `Default ${SEARCH_LIMIT}, at most ${SEARCH_MAX}.` })),
			project: projectArg(),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rows = openStore().search({
				scopes: readScopes(ctx, params.project),
				query: params.query,
				kinds: params.kinds as MemoryKind[] | undefined,
				limit: Math.min(SEARCH_MAX, Math.max(1, Math.floor(params.limit ?? SEARCH_LIMIT))),
			});
			if (rows.length === 0) return { content: [{ type: "text", text: "No matching memories." }], details: { count: 0, ids: [] } };
			const lines = rows.map((r) => formatSearchRow(r, settings.recall.inlineChars));
			const anyShort = lines.some((l) => l.shortened);
			const text = lines.map((l) => l.text).join("\n") + (anyShort ? "\n\nShortened lines end in [N chars]; memory_get gives the full text." : "");
			return { content: [{ type: "text", text }], details: { count: rows.length, ids: rows.map((r) => r.id) } };
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Read memory",
		...listRenderers("Read memory", (a) => (Array.isArray(a?.ids) ? a.ids.map((i: number) => `#${i}`).join(" ") : "")),
		description: "Full text of memories by id, for ones that recall or memory_search showed shortened.",
		promptSnippet: "memory_get: full text of memories by id",
		parameters: Type.Object({
			ids: Type.Array(Type.Number(), { description: `Memory ids, at most ${GET_MAX_IDS}.`, minItems: 1 }),
			project: projectArg(),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const scopes = readScopes(ctx, params.project);
			const unique = [...new Set(params.ids.map((i) => Math.floor(i)))];
			const ids = unique.slice(0, GET_MAX_IDS);
			const rows = openStore().getMany(ids).filter((r) => scopes.includes(r.scope));
			const missing = ids.filter((i) => !rows.some((r) => r.id === i));
			const parts: string[] = [];
			const shown: MemoryRow[] = [];
			let used = 0;
			let cut = 0;
			for (const r of rows) {
				const text = formatRow(r);
				if (used + text.length > GET_MAX_CHARS && shown.length > 0) {
					cut++;
					continue;
				}
				parts.push(text);
				shown.push(r);
				used += text.length;
			}
			if (missing.length) parts.push(`Not found here: ${missing.map((i) => `#${i}`).join(" ")}.`);
			if (cut) parts.push(`${memories(cut)} left out to keep this under ${GET_MAX_CHARS} characters; ask for fewer ids.`);
			if (unique.length > GET_MAX_IDS) parts.push(`Only the first ${GET_MAX_IDS} ids were read.`);
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: { count: shown.length, ids: shown.map((r) => r.id) } };
		},
	});

	// -------------------------------------------------------------------------- recall

	pi.registerMessageRenderer<RecallDetails>(
		RECALL_TYPE,
		recallRenderer({ halo: haloLoaded, expandHint: () => keyHint("app.tools.expand", "to expand") }),
	);

	/**
	 * The recall message in the model's current context: its details, null for one without them
	 * (an older version's), undefined when there is none. Reads the context as pi builds it, so a
	 * recall that compaction summarised away, or one on another branch, does not count.
	 */
	function recallInContext(ctx: ExtensionContext): RecallDetails | null | undefined {
		const sm = ctx.sessionManager as { buildContextEntries?: () => unknown[]; getBranch: () => unknown[] };
		let entries: unknown[];
		if (typeof sm.buildContextEntries === "function") {
			entries = sm.buildContextEntries();
		} else {
			// Without buildContextEntries: the branch since its latest compaction is close enough.
			const branch = sm.getBranch();
			let from = 0;
			for (let i = branch.length - 1; i >= 0; i--) if ((branch[i] as { type?: string })?.type === "compaction") { from = i; break; }
			entries = branch.slice(from);
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; details?: RecallDetails };
			if (e?.type === "custom_message" && e.customType === RECALL_TYPE) return e.details && typeof e.details.count === "number" ? e.details : null;
		}
		return undefined;
	}

	/** Memories saved or changed on this branch, newest first, that still exist. */
	function touchedOnBranch(ctx: ExtensionContext): MemoryRow[] {
		const ids: number[] = [];
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			const m = e?.type === "message" ? e.message : undefined;
			if (m?.role === "toolResult" && (m.toolName === "memory_write" || m.toolName === "memory_update") && typeof m.details?.id === "number") ids.push(m.details.id);
		}
		return openStore().getMany([...new Set(ids.reverse())]);
	}

	/** Bring the sidebar's numbers in line with the current context and branch. */
	function syncSide(ctx: ExtensionContext) {
		const prior = recallInContext(ctx);
		side.recalled = prior?.count ?? 0;
		// A recall from an older version has no total; show its count as the total.
		side.total = prior?.total ?? prior?.count ?? 0;
		side.chars = prior?.chars ?? 0;
		side.budget = settings.recall.maxChars;
		side.touched = touchedOnBranch(ctx);
		sidebar?.refresh();
	}

	/**
	 * Set once recall has been looked at for the current context, even when it came out empty, so
	 * an empty or failed recall is not recomputed (and its notice not repeated) on every prompt.
	 * Cleared when the context changes underneath: a new session, compaction, a move in the tree.
	 */
	let recallChecked = false;
	const resetRecall = () => {
		recallChecked = false;
	};

	pi.on("session_start", (_event, ctx) => {
		const loaded = loadSettings(settingsPath(getAgentDir()));
		settings = loaded.settings;
		if (loaded.error && ctx.hasUI) ctx.ui.notify(`pi-domain: ignoring ${loaded.path} (${loaded.error})`, "warning");
		const s = openStore();
		// A snapshot when the newest is old enough, quietly: only a failure is worth a word.
		try {
			autoBackup({
				from: location().path,
				dir: backupDirFor(location()),
				memories: s.stats().reduce((n, st) => n + st.count, 0),
				hours: settings.backup.everyHours,
				keep: settings.backup.keep,
			});
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`pi-domain: automatic backup failed: ${(err as Error).message}`, "warning");
		}
		resetRecall();
		sidebar?.dispose();
		sidebar = registerSidebar(pi, ctx, () => side, async (row, c) => {
			const fresh = openStore().get(row.id);
			if (c?.hasUI) await c.ui.select(`Memory #${row.id}`, [fresh ? formatRow(fresh) : `#${row.id} was deleted`]);
		});
		syncSide(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		resetRecall();
		syncSide(ctx);
	});

	// Recall rides along with the first prompt of a context: once per session, again after
	// compaction has summarised the earlier one away, never twice (a reload or resume finds it).
	pi.on("before_agent_start", (event, ctx) => {
		if (recallChecked || recallInContext(ctx) !== undefined) return;
		recallChecked = true;
		const r = settings.recall;
		if (r.maxChars === 0 || r.maxItems === 0) return;
		const s = openStore();
		const project = resolveProjectScope(ctx.cwd);
		// More rows than can fit, so the budget, not the query, decides what is listed.
		const want = r.maxItems * 2 + 10;
		const p = s.recallable(project, want);
		const g = s.recallable(GLOBAL_SCOPE, want);
		if (p.total + g.total === 0) return;
		let related: MemoryRow[] = [];
		try {
			related = s.match([project, GLOBAL_SCOPE], event.prompt ?? "", RELATED_LIMIT);
		} catch {
			// a prompt the search cannot use; recall the rest
		}
		const digest = buildDigest(
			{ project: p.rows, global: g.rows, related, totals: { project: p.total, global: g.total } },
			{ maxChars: r.maxChars, maxItems: r.maxItems, globalShare: r.globalShare, inlineChars: r.inlineChars, projectScope: project },
		);
		if (digest.pinnedLeftOut > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`pi-domain: ${digest.pinnedLeftOut} pinned ${digest.pinnedLeftOut === 1 ? "memory does" : "memories do"} not fit the recall budget; shorten or unpin some (/memory-tidy), or raise recall.maxChars`,
				"info",
			);
		}
		side.recalled = digest.ids.length;
		side.total = digest.total;
		side.chars = digest.text.length;
		side.budget = r.maxChars;
		sidebar?.refresh();
		if (!digest.text) return;
		const details: RecallDetails = { count: digest.ids.length, total: digest.total, chars: digest.text.length, ids: digest.ids };
		return { message: { customType: RECALL_TYPE, content: digest.text, display: true, details } };
	});

	// Compaction distils the conversation into a summary. Kept only when summaries.save is on (off by default).
	pi.on("session_compact", (event, ctx) => {
		// The recall may be in the summarised part; the next prompt checks again.
		resetRecall();
		syncSide(ctx);
		if (!settings.summaries.save) return;
		const summary = event.compactionEntry.summary?.trim();
		if (!summary) return;
		const max = settings.summaries.maxChars;
		openStore().write({
			scope: resolveProjectScope(ctx.cwd),
			kind: "summary",
			text: summary.length > max ? `${summary.slice(0, max)}…` : summary,
			tags: ["compaction", event.reason],
			sessionId: ctx.sessionManager.getSessionId() ?? null,
		});
	});

	pi.on("session_shutdown", () => {
		sidebar?.dispose();
		sidebar = undefined;
		store?.close();
		store = undefined;
		where = undefined;
	});

	// ------------------------------------------------------------------------ commands

	pi.registerCommand("memory", {
		description: "List or search memories for this project (/memory [words])",
		handler: async (args, ctx) => {
			const s = openStore();
			const scopes = resolveReadScopes(ctx.cwd);
			const query = args.trim();
			const rows = s.search({ scopes, query: query || undefined, limit: 50 });
			const counts = s.stats(scopes).map((st) => `${st.scope}: ${st.count} (${st.pinned} pinned)`).join("  |  ") || "no memories yet";
			const recall = side.total > 0 ? `  |  recall: ${side.recalled} of ${side.total}, ${compactChars(side.chars)} of ${compactChars(side.budget)} chars` : "";
			const header = `${counts}${recall}`;
			if (!ctx.hasUI) {
				console.log([header, ...rows.map(formatRow)].join("\n"));
				return;
			}
			if (rows.length === 0) {
				ctx.ui.notify(`No memories match. ${header}`, "info");
				return;
			}
			await ctx.ui.select(`Memories: ${header}`, rows.map(formatRow));
		},
	});

	pi.registerCommand("memory-forget", {
		description: "Delete a memory by id (/memory-forget 12)",
		handler: async (args, ctx) => {
			const id = Number.parseInt(args.trim(), 10);
			if (!Number.isInteger(id)) return ctx.ui.notify("Usage: /memory-forget <id>", "warning");
			const s = openStore();
			const row = s.get(id);
			if (!row) return ctx.ui.notify(`No memory #${id}`, "warning");
			if (!ctx.hasUI) return ctx.ui.notify("/memory-forget asks you to confirm, so it only runs in the interactive UI", "error");
			if (!(await ctx.ui.confirm("Delete memory?", formatRow(row)))) return;
			s.forget(id);
			side.touched = side.touched.filter((r) => r.id !== id);
			sidebar?.refresh();
			ctx.ui.notify(`Deleted memory #${id}`, "info");
		},
	});

	pi.registerCommand("memory-pin", {
		description: "Pin or unpin a memory (/memory-pin 12)",
		handler: async (args, ctx) => {
			const id = Number.parseInt(args.trim(), 10);
			if (!Number.isInteger(id)) return ctx.ui.notify("Usage: /memory-pin <id>", "warning");
			const s = openStore();
			const row = s.get(id);
			if (!row) return ctx.ui.notify(`No memory #${id}`, "warning");
			s.setPinned(id, !row.pinned);
			ctx.ui.notify(`Memory #${id} ${row.pinned ? "unpinned" : "pinned"}`, "info");
		},
	});

	pi.registerCommand("memory-tidy", {
		description: "Move misfiled memories, then review overlapping, long and old ones (/memory-tidy [all])",
		getArgumentCompletions: (prefix) => ("all".startsWith(prefix.trim()) ? [{ value: "all", label: "all", description: "every project, not just this one" }] : null),
		handler: async (args, ctx) => {
			const s = openStore();
			const everywhere = args.trim().toLowerCase() === "all";
			const scopes = everywhere ? s.scopes() : resolveReadScopes(ctx.cwd);

			// Memories filed under a folder that is not a git repository, whose text names a project.
			// A scope is a repository when a git directory of that name exists under the repo roots.
			const repos = findRepos(defaultRepoRoots());
			const here = resolveProjectScope(ctx.cwd);
			const inRepo = isInGitRepo(ctx.cwd);
			const misfiled = findMisfiled(
				s.inScopes(scopes),
				(scope) => !repos.has(scope.slice("project:".length)) && !(inRepo && scope === here),
				[...repos.keys()],
			);
			const candidates = s.tidyCandidates(scopes, { keepSummaries: settings.summaries.keep, longChars: settings.write.warnChars });
			const total = misfiled.length + candidates.length;
			const where = everywhere ? "every project" : scopes.join(" and ");
			if (total === 0) return ctx.ui.notify(`Nothing to tidy in ${where}.`, "info");
			const counts = new Map<string, number>();
			for (const c of candidates) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
			const summary = [...(misfiled.length ? [`${misfiled.length} misfiled`] : []), ...[...counts].map(([t, n]) => `${n} ${t}`)].join(", ");
			if (!ctx.hasUI) {
				// Never change anything without a person confirming each row.
				console.log([`${total} suggestions in ${where}: ${summary}`, ...misfiled.map((m) => `misfiled #${m.row.id}: ${m.row.scope} -> ${m.to} (${m.evidence})`), ...candidates.map((c) => `${c.type} #${c.drop.id}: ${c.reason}`)].join("\n"));
				return;
			}
			ctx.ui.notify(`Memory tidy in ${where}: ${total} suggestions (${summary}).${everywhere ? "" : " /memory-tidy all covers every project."}`, "info");

			let deleted = 0;
			let moved = 0;
			let kept = 0;
			let stopped = false;
			const merges: string[] = [];
			const shorten: number[] = [];
			let n = 0;
			for (const m of misfiled) {
				if (!s.get(m.row.id)) continue;
				n++;
				const body = `${m.row.scope} is a folder, not a project, and this mentions ${m.evidence}.\n\nMove to ${m.to}:\n  ${formatRow(m.row)}`;
				const choice = await ctx.ui.select(`Memory tidy ${n}/${total} (misfiled)\n\n${body}`, [`Move to ${m.to}`, "Make global", "Keep here", "Stop"]);
				if (choice === undefined || choice === "Stop") {
					stopped = true;
					break;
				}
				try {
					if (choice.startsWith("Move to")) (s.update(m.row.id, { scope: m.to }), moved++);
					else if (choice === "Make global") (s.update(m.row.id, { scope: GLOBAL_SCOPE }), moved++);
					else kept++;
				} catch (err) {
					ctx.ui.notify(`Could not move #${m.row.id}: ${(err as Error).message}`, "warning");
				}
			}
			for (const c of stopped ? [] : candidates) {
				if (!s.get(c.drop.id)) continue; // removed earlier in this pass
				n++;
				const body =
					`${c.reason}\n\n${c.type === "extends" ? "Fold in" : c.type === "too-long" ? "Shorten" : "Delete"}:\n  ${formatRow(c.drop)}` +
					(c.keep ? `\n\nKeep:\n  ${formatRow(c.keep)}` : "");
				const options =
					c.type === "too-long"
						? ["Ask agent to shorten", "Keep as is", "Stop"]
						: [
								...(c.keep && c.type !== "superseded" ? ["Ask agent to merge"] : []),
								...(c.type === "extends" ? [] : ["Delete"]),
								"Keep both",
								"Stop",
							];
				const choice = await ctx.ui.select(`Memory tidy ${n}/${total} (${c.type})\n\n${body}`, options);
				if (choice === undefined || choice === "Stop") break;
				if (choice === "Delete" && s.forget(c.drop.id)) deleted++;
				else if (choice === "Ask agent to merge") merges.push(`#${c.drop.id} into #${c.keep!.id}`);
				else if (choice === "Ask agent to shorten") shorten.push(c.drop.id);
				else kept++;
			}
			const sent = merges.length + shorten.length;
			const done = [
				moved ? `moved ${moved}` : "",
				deleted ? `deleted ${deleted}` : "",
				sent ? `${sent} sent to the agent to ${merges.length && shorten.length ? "merge or shorten" : merges.length ? "merge" : "shorten"}` : "",
				kept ? `kept ${kept}` : "",
			].filter(Boolean);
			ctx.ui.notify(`Memory tidy: ${done.length ? done.join(", ") : "no changes"}.`, "info");
			if (moved) {
				side.touched = side.touched.map((r) => s.get(r.id) ?? r);
				sidebar?.refresh();
			}
			if (sent === 0) return;
			// Rewritten text needs the model.
			const asks: string[] = [];
			if (merges.length) {
				asks.push(
					`Merge these memories: ${merges.join(", ")}. For each pair, use memory_update to rewrite the kept memory so it holds everything still true from both ` +
						`(drop "Extends #N"/"Supersedes #N" wording), then delete the other with memory_forget.`,
				);
			}
			if (shorten.length) {
				asks.push(
					`Shorten memories ${shorten.map((id) => `#${id}`).join(", ")} (read them with memory_get). Keep what a later session needs, key point first, ` +
						`under ${settings.recall.inlineChars} characters where possible; split unrelated points into new memories with memory_write. Use memory_update to rewrite.`,
				);
			}
			const msg = `From /memory-tidy: ${asks.join(" ")} Show me the new text when done.`;
			if (ctx.isIdle()) pi.sendUserMessage(msg);
			else pi.sendUserMessage(msg, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("memory-backup", {
		description: "Save a checked snapshot of the memory database",
		handler: async (_args, ctx) => {
			openStore(); // creates the database on a first run, so there is a file to copy
			try {
				const r = backupDb(location().path, backupDirFor(location()), new Date(), settings.backup.keep);
				ctx.ui.notify(`Backed up ${memories(r.memories)} to ${r.to}${r.pruned.length ? `, removed ${r.pruned.length} older` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(`Backup failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("memory-restore", {
		description: "Replace all memories with a snapshot (/memory-restore [snapshot])",
		handler: async (args, ctx) => {
			const s = openStore();
			const dir = backupDirFor(location());
			const snaps = listSnapshots(dir);
			if (snaps.length === 0) return ctx.ui.notify(`No snapshots in ${dir}. Make one with /memory-backup`, "warning");
			if (!ctx.hasUI) return ctx.ui.notify("/memory-restore replaces every memory and asks you to confirm, so it only runs in the interactive UI", "error");
			const want = args.trim();
			let snap = want ? findSnapshot(snaps, want) : undefined;
			if (want && !snap) return ctx.ui.notify(`No snapshot named ${want}. /memory-restore lists them`, "warning");
			if (!snap) {
				const labels = snaps.map(snapshotLabel);
				const choice = await ctx.ui.select("Restore which snapshot? (newest first)", labels);
				if (choice === undefined) return;
				snap = snaps[labels.indexOf(choice)];
			}
			if (!snap || snap.error) return ctx.ui.notify(`${snap?.name ?? "That snapshot"} cannot be restored${snap?.error ? `: ${snap.error}` : ""}`, "error");
			const now = s.stats().reduce((n, st) => n + st.count, 0);
			const ok = await ctx.ui.confirm(
				`Restore ${snap.name}?`,
				`This replaces all ${now} current memories with the ${snap.memories} in the snapshot. A snapshot of the current state is saved first, so it can be undone.`,
			);
			if (!ok) return;
			try {
				const r = restoreSnapshot(s, location().path, dir, snap.name);
				ctx.ui.notify(`Restored ${memories(r.after)} from ${r.from.name} (was ${r.before}). Previous state: ${r.safety}`, "info");
			} catch (err) {
				ctx.ui.notify(`Restore failed, nothing changed: ${(err as Error).message}`, "error");
			}
		},
	});
}

/**
 * SQLite-backed memory store for pi-recall.
 *
 * Deliberately free of any pi imports so it can be exercised standalone with
 * `node --experimental-strip-types store.test.ts`.
 *
 * Storage: one database file, shared by every pi process on this machine.
 * WAL plus a busy timeout is what makes concurrent sessions safe; SQLite
 * serialises writers for us, so no external server is involved.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Memory categories. Kept small on purpose so search stays predictable. */
export const MEMORY_KINDS = ["decision", "preference", "fact", "gotcha", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRow {
	id: number;
	scope: string;
	kind: MemoryKind;
	text: string;
	tags: string[];
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
	sessionId: string | null;
}

export interface WriteMemoryInput {
	scope: string;
	kind: MemoryKind;
	text: string;
	tags?: string[];
	pinned?: boolean;
	sessionId?: string | null;
}

export interface WriteMemoryResult {
	row: MemoryRow;
	/** True when an existing row with identical normalised text was refreshed instead of inserted. */
	deduplicated: boolean;
}

/** Fields that `update` may change; omitted fields keep their current value. */
export interface UpdateMemoryInput {
	scope?: string;
	kind?: MemoryKind;
	text?: string;
	tags?: string[];
	pinned?: boolean;
}

/**
 * A suggested cleanup from `tidyCandidates`. Always a suggestion: the store never
 * deletes on its own, the caller asks the user first.
 */
export interface TidyCandidate {
	type: "superseded" | "similar" | "old-summary" | "extends" | "too-long";
	/** The row suggested for deletion (for "extends": the one to fold into `keep`; for "too-long": the one to shorten). */
	drop: MemoryRow;
	/** The row that makes `drop` redundant (absent for old summaries). */
	keep?: MemoryRow;
	reason: string;
}

export interface TidyOptions {
	/** Word-set Jaccard similarity at or above which two memories count as overlapping. */
	similarity?: number;
	/** Compaction summaries to keep per scope; older ones are suggested for deletion. */
	keepSummaries?: number;
	/** Memories (other than summaries) longer than this are suggested for shortening. 0 turns it off. */
	longChars?: number;
}

export interface SearchOptions {
	/** Scopes to search, in priority order. Rows outside these scopes are excluded. */
	scopes: string[];
	query?: string;
	kinds?: MemoryKind[];
	limit?: number;
}

export const SCHEMA_VERSION = 1;

/**
 * `content=` external-content FTS5 would avoid duplicating text, but it makes
 * the index silently stale if a write ever bypasses the triggers. Storing the
 * text twice costs little for prose-sized rows and keeps the index verifiable.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	scope      TEXT    NOT NULL,
	kind       TEXT    NOT NULL,
	text       TEXT    NOT NULL,
	norm_hash  TEXT    NOT NULL,
	tags       TEXT    NOT NULL DEFAULT '[]',
	pinned     INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	session_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_hash ON memories (scope, norm_hash);
CREATE INDEX IF NOT EXISTS memories_scope_updated ON memories (scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_scope_pinned ON memories (scope, pinned DESC, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5 (
	text,
	tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
	DELETE FROM memories_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
	DELETE FROM memories_fts WHERE rowid = old.id;
	INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;
`;

/** Collapse whitespace and case so trivially-reworded duplicates collide. */
function normalize(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hashText(text: string): string {
	return createHash("sha256").update(normalize(text)).digest("hex").slice(0, 32);
}

/** Words too common to say anything about overlap between two memories. */
const STOPWORDS = new Set(
	(
		"the and for with that this from into when then than are was were has have had not but its " +
		"can use uses used via also only just so them they their there which while where what who " +
		"all any per one two out off own does did doing been being will would should could must"
	).split(" "),
);

function wordSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}_./#-]+/u)
			.map((w) => w.replace(/^[.#/-]+|[.#/-]+$/g, ""))
			.filter((w) => w.length > 2 && !STOPWORDS.has(w)),
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared++;
	return shared / (a.size + b.size - shared);
}

/**
 * Ids a memory says it replaces: "Supersedes memory #33", "Supersedes #9 and #13",
 * "Supersedes the last clause of memory #18". "Extends #N" is not a replacement.
 */
export function supersededIds(text: string): number[] {
	const ids = new Set<number>();
	for (const m of text.matchAll(/\bsupersed(?:es|ing)\b([^.;]*)/gi)) {
		for (const id of m[1].matchAll(/#(\d+)/g)) ids.add(Number(id[1]));
	}
	return [...ids];
}

/** Ids a memory says it builds on: "Extends pinned memories #9/#13". Merge candidates, not stale. */
export function extendedIds(text: string): number[] {
	const ids = new Set<number>();
	for (const m of text.matchAll(/\bextend(?:s|ing)\b([^.:;]*)/gi)) {
		for (const id of m[1].matchAll(/#(\d+)/g)) ids.add(Number(id[1]));
	}
	return [...ids];
}

/**
 * True when the replacement only covers part of the old memory: "Supersedes the last
 * clause of memory #18", "Supersedes memory #10's workaround note".
 */
function isPartialSupersede(text: string): boolean {
	return (
		/\bsupersed(?:es|ing)\s+the\s+[\w\s-]*?\b(?:clause|part|sentence|note)\s+of\b/i.test(text) ||
		/\bsupersed(?:es|ing)\s+(?:memory\s+)?#\d+'s\b/i.test(text)
	);
}

/**
 * Build a safe FTS5 MATCH expression from arbitrary text.
 *
 * FTS5 treats `-`, `*`, `:`, `^`, `"`, and `NEAR` as syntax, so a raw model- or
 * user-supplied string can be a syntax error or, worse, a silently different
 * query. Every token is reduced to alphanumerics and wrapped as a quoted
 * phrase; tokens are OR-ed and bm25 handles the ranking.
 *
 * Returns undefined when nothing searchable survives, which callers treat as
 * "no text filter" rather than "no results".
 */
export function buildMatchExpression(query: string): string | undefined {
	const terms = query
		.split(/[^\p{L}\p{N}_]+/u)
		.map((t) => t.trim())
		.filter((t) => t.length > 1);
	if (terms.length === 0) return undefined;
	return terms.map((t) => `"${t}"`).join(" OR ");
}

function toRow(raw: Record<string, unknown>): MemoryRow {
	let tags: string[] = [];
	try {
		const parsed = JSON.parse(String(raw.tags ?? "[]"));
		if (Array.isArray(parsed)) tags = parsed.map(String);
	} catch {
		// A malformed tags blob should not make the whole row unreadable.
		tags = [];
	}
	return {
		id: Number(raw.id),
		scope: String(raw.scope),
		kind: String(raw.kind) as MemoryKind,
		text: String(raw.text),
		tags,
		pinned: Number(raw.pinned) === 1,
		createdAt: Number(raw.created_at),
		updatedAt: Number(raw.updated_at),
		sessionId: raw.session_id == null ? null : String(raw.session_id),
	};
}

/** The columns of a stored memory, in the order replaceAll writes them. */
export const ROW_COLUMNS = ["id", "scope", "kind", "text", "norm_hash", "tags", "pinned", "created_at", "updated_at", "session_id"] as const;
export type RawMemoryRow = Record<(typeof ROW_COLUMNS)[number], SQLInputValue>;

export class MemoryStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new DatabaseSync(dbPath);
		// WAL lets readers proceed during a write; the timeout absorbs the brief
		// writer lock when several pi sessions flush at once.
		if (dbPath !== ":memory:") {
			this.db.exec("PRAGMA journal_mode = WAL");
		}
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(SCHEMA);
		this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// Already closed. Cleanup must stay idempotent.
		}
	}

	/**
	 * Insert a memory, or refresh the existing one when the same scope already
	 * holds text that normalises identically. Re-stating a fact should bump its
	 * recency, not grow the table.
	 */
	write(input: WriteMemoryInput): WriteMemoryResult {
		const now = Date.now();
		const hash = hashText(input.text);
		const tags = JSON.stringify(input.tags ?? []);

		const existing = this.db
			.prepare("SELECT * FROM memories WHERE scope = ? AND norm_hash = ?")
			.get(input.scope, hash) as Record<string, unknown> | undefined;

		if (existing) {
			this.db
				.prepare(
					`UPDATE memories
					    SET kind = ?, text = ?, tags = ?, pinned = MAX(pinned, ?), updated_at = ?, session_id = ?
					  WHERE id = ?`,
				)
				.run(
					input.kind,
					input.text,
					tags,
					input.pinned ? 1 : 0,
					now,
					input.sessionId ?? null,
					Number(existing.id),
				);
			return { row: this.get(Number(existing.id))!, deduplicated: true };
		}

		const res = this.db
			.prepare(
				`INSERT INTO memories (scope, kind, text, norm_hash, tags, pinned, created_at, updated_at, session_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.scope,
				input.kind,
				input.text,
				hash,
				tags,
				input.pinned ? 1 : 0,
				now,
				now,
				input.sessionId ?? null,
			);
		return { row: this.get(Number(res.lastInsertRowid))!, deduplicated: false };
	}

	get(id: number): MemoryRow | undefined {
		const raw = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return raw ? toRow(raw) : undefined;
	}

	/**
	 * Change a memory in place (text, kind, tags, pin, or scope). Refuses to create a
	 * duplicate: if the target scope already holds the same normalised text, it throws.
	 */
	update(id: number, patch: UpdateMemoryInput): MemoryRow | undefined {
		const row = this.get(id);
		if (!row) return undefined;
		const scope = patch.scope ?? row.scope;
		const text = patch.text ?? row.text;
		const hash = hashText(text);
		const clash = this.db
			.prepare("SELECT id FROM memories WHERE scope = ? AND norm_hash = ? AND id != ?")
			.get(scope, hash, id) as Record<string, unknown> | undefined;
		if (clash) {
			throw new Error(`memory #${clash.id} in ${scope} already has that text`);
		}
		this.db
			.prepare(
				`UPDATE memories
				    SET scope = ?, kind = ?, text = ?, norm_hash = ?, tags = ?, pinned = ?, updated_at = ?
				  WHERE id = ?`,
			)
			.run(
				scope,
				patch.kind ?? row.kind,
				text,
				hash,
				JSON.stringify(patch.tags ?? row.tags),
				(patch.pinned ?? row.pinned) ? 1 : 0,
				Date.now(),
				id,
			);
		return this.get(id);
	}

	/**
	 * Suggest cleanups within `scopes`, most certain first:
	 *  1. superseded: a newer memory says "Supersedes #N" (partial replacements are labelled);
	 *  2. old-summary: compaction summaries beyond the newest `keepSummaries` per scope;
	 *  3. similar: same scope and kind with heavily overlapping wording (older one suggested);
	 *  4. extends: "Extends #N" notes to fold into the memory they extend;
	 *  5. too-long: memories over `longChars`, longest first, to be shortened.
	 * Each row is suggested at most once. Nothing is deleted here.
	 */
	tidyCandidates(scopes: string[], options: TidyOptions = {}): TidyCandidate[] {
		const threshold = options.similarity ?? 0.5;
		const keepSummaries = options.keepSummaries ?? 3;
		const scopeList = scopes.length > 0 ? scopes : ["global"];
		const rows = (
			this.db
				.prepare(
					`SELECT * FROM memories WHERE scope IN (${scopeList.map(() => "?").join(", ")})
					  ORDER BY updated_at DESC, id DESC`,
				)
				.all(...scopeList) as Record<string, unknown>[]
		).map(toRow);
		const byId = new Map(rows.map((r) => [r.id, r]));
		const out: TidyCandidate[] = [];
		const dropped = new Set<number>();
		const add = (c: TidyCandidate) => {
			if (dropped.has(c.drop.id) || (c.keep && dropped.has(c.keep.id))) return;
			dropped.add(c.drop.id);
			out.push(c);
		};

		for (const r of rows) {
			for (const id of supersededIds(r.text)) {
				const old = byId.get(id);
				if (!old || old.id === r.id) continue;
				const partial = isPartialSupersede(r.text);
				add({
					type: "superseded",
					drop: old,
					keep: r,
					reason: partial
						? `#${r.id} replaces part of #${old.id}; check nothing else in #${old.id} is still needed`
						: `#${r.id} says it supersedes #${old.id}`,
				});
			}
		}

		const summariesByScope = new Map<string, MemoryRow[]>();
		for (const r of rows) {
			if (r.kind !== "summary" || r.pinned) continue;
			const list = summariesByScope.get(r.scope) ?? [];
			list.push(r);
			summariesByScope.set(r.scope, list);
		}
		for (const [scope, list] of summariesByScope) {
			for (const old of list.slice(keepSummaries)) {
				add({
					type: "old-summary",
					drop: old,
					reason: `older than the newest ${keepSummaries} compaction summaries in ${scope}`,
				});
			}
		}

		const words = new Map(rows.map((r) => [r.id, wordSet(r.text)]));
		const pairs: { a: MemoryRow; b: MemoryRow; score: number }[] = [];
		for (let i = 0; i < rows.length; i++) {
			for (let j = i + 1; j < rows.length; j++) {
				const a = rows[i]; // newer (rows are newest first)
				const b = rows[j];
				if (a.scope !== b.scope || a.kind !== b.kind || a.kind === "summary") continue;
				const score = jaccard(words.get(a.id)!, words.get(b.id)!);
				if (score >= threshold) pairs.push({ a, b, score });
			}
		}
		pairs.sort((x, y) => y.score - x.score);
		for (const { a, b, score } of pairs) {
			// Suggest dropping the older one, unless only the older one is pinned.
			const [keep, drop] = b.pinned && !a.pinned ? [b, a] : [a, b];
			add({
				type: "similar",
				drop,
				keep,
				reason: `#${drop.id} and #${keep.id} overlap (${Math.round(score * 100)}% shared words); merge or keep both`,
			});
		}

		// "Extends #N" chains: fold the extension into the memory it extends (oldest first).
		for (const r of [...rows].reverse()) {
			for (const id of extendedIds(r.text)) {
				const base = byId.get(id);
				if (!base || base.id === r.id || base.scope !== r.scope) continue;
				add({
					type: "extends",
					drop: r,
					keep: base,
					reason: `#${r.id} extends #${base.id}; merge them into #${base.id}`,
				});
				break;
			}
		}

		const longChars = options.longChars ?? 0;
		if (longChars > 0) {
			const long = rows.filter((r) => r.kind !== "summary" && r.text.length > longChars).sort((a, b) => b.text.length - a.text.length);
			for (const r of long) {
				add({ type: "too-long", drop: r, reason: `#${r.id} is ${r.text.length} characters; shorter memories recall better` });
			}
		}
		return out;
	}

	forget(id: number): boolean {
		return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
	}

	/**
	 * Replace every memory with `rows`, in one transaction: either all of it happens or none of it.
	 * Ids are kept as given. Ids above the highest the table has ever used are never handed out
	 * twice (AUTOINCREMENT keeps its high-water mark), so a note number cannot start to mean
	 * something else. Other sessions with the file open see the result on their next read.
	 */
	replaceAll(rows: RawMemoryRow[]): { before: number; after: number } {
		const count = (table: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
		this.db.exec("BEGIN IMMEDIATE"); // takes the write lock, waiting up to busy_timeout
		try {
			const before = count("memories");
			this.db.exec("DELETE FROM memories");
			const insert = this.db.prepare(`INSERT INTO memories (${ROW_COLUMNS.join(", ")}) VALUES (${ROW_COLUMNS.map(() => "?").join(", ")})`);
			for (const row of rows) insert.run(...ROW_COLUMNS.map((c) => row[c]));
			const after = count("memories");
			if (after !== rows.length) throw new Error(`wrote ${after} memories, expected ${rows.length}`);
			const indexed = count("memories_fts");
			if (indexed !== after) throw new Error(`the search index has ${indexed} entries for ${after} memories`);
			this.db.exec("COMMIT");
			return { before, after };
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw err;
		}
	}

	setPinned(id: number, pinned: boolean): boolean {
		return (
			this.db
				.prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?")
				.run(pinned ? 1 : 0, Date.now(), id).changes > 0
		);
	}

	/**
	 * Full-text search when a query is given, recency listing otherwise.
	 * Pinned rows always sort first so they survive a tight limit.
	 *
	 * Millisecond timestamps tie when rows are written in quick succession, so
	 * `id DESC` breaks ties to keep recency ordering deterministic.
	 */
	search(options: SearchOptions): MemoryRow[] {
		const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
		const scopes = options.scopes.length > 0 ? options.scopes : ["global"];
		const scopePlaceholders = scopes.map(() => "?").join(", ");

		const kindFilter =
			options.kinds && options.kinds.length > 0
				? ` AND m.kind IN (${options.kinds.map(() => "?").join(", ")})`
				: "";
		const kindParams = options.kinds ?? [];

		const match = options.query ? buildMatchExpression(options.query) : undefined;

		if (match) {
			const rows = this.db
				.prepare(
					`SELECT m.*
					   FROM memories_fts f
					   JOIN memories m ON m.id = f.rowid
					  WHERE f.text MATCH ?
					    AND m.scope IN (${scopePlaceholders})${kindFilter}
					  ORDER BY m.pinned DESC, bm25(memories_fts) ASC, m.updated_at DESC, m.id DESC
					  LIMIT ?`,
				)
				.all(match, ...scopes, ...kindParams, limit) as Record<string, unknown>[];
			return rows.map(toRow);
		}

		const rows = this.db
			.prepare(
				`SELECT m.*
				   FROM memories m
				  WHERE m.scope IN (${scopePlaceholders})${kindFilter}
				  ORDER BY m.pinned DESC, m.updated_at DESC, m.id DESC
				  LIMIT ?`,
			)
			.all(...scopes, ...kindParams, limit) as Record<string, unknown>[];
		return rows.map(toRow);
	}

	/**
	 * Rows injected at session start: every pinned memory, then the most recent
	 * others up to `limit`.
	 */
	recall(scopes: string[], limit: number): MemoryRow[] {
		const scopeList = scopes.length > 0 ? scopes : ["global"];
		const placeholders = scopeList.map(() => "?").join(", ");
		const pinned = this.db
			.prepare(
				`SELECT * FROM memories
				  WHERE scope IN (${placeholders}) AND pinned = 1
				  ORDER BY updated_at DESC, id DESC`,
			)
			.all(...scopeList) as Record<string, unknown>[];
		const remaining = Math.max(0, limit - pinned.length);
		const recent =
			remaining === 0
				? []
				: (this.db
						.prepare(
							`SELECT * FROM memories
							  WHERE scope IN (${placeholders}) AND pinned = 0
							  ORDER BY updated_at DESC, id DESC
							  LIMIT ?`,
						)
						.all(...scopeList, remaining) as Record<string, unknown>[]);
		return [...pinned, ...recent].map(toRow);
	}

	/**
	 * Memories (not summaries) that share distinctive words with `text`, best match first: the
	 * session's first prompt, so recall can list what it is likely about. Common words are ignored,
	 * so a prompt like "go on" matches nothing.
	 */
	match(scopes: string[], text: string, limit: number): MemoryRow[] {
		if (limit <= 0) return [];
		// Compound words (package.json, src/foo.ts, node-sqlite) count by their parts.
		const parts = [...wordSet(text)].flatMap((w) => w.split(/[^\p{L}\p{N}]+/u));
		const words = [...new Set(parts)].filter((w) => w.length >= 4 && !STOPWORDS.has(w) && /\p{L}/u.test(w)).slice(0, 24);
		const expr = buildMatchExpression(words.join(" "));
		if (!expr || scopes.length === 0) return [];
		return (
			this.db
				.prepare(
					`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
					  WHERE f.text MATCH ? AND m.scope IN (${scopes.map(() => "?").join(", ")}) AND m.kind != 'summary'
					  ORDER BY bm25(memories_fts) ASC, m.updated_at DESC LIMIT ?`,
				)
				.all(expr, ...scopes, limit) as Record<string, unknown>[]
		).map(toRow);
	}

	/** Several rows by id, in the order given; ids that do not exist are left out. */
	getMany(ids: number[]): MemoryRow[] {
		return ids.map((id) => this.get(id)).filter((r): r is MemoryRow => r !== undefined);
	}

	/**
	 * Rows of one scope that may be recalled at session start (everything but summaries), pinned
	 * first, then newest first, at most `limit`; and how many there are in all.
	 */
	recallable(scope: string, limit: number): { rows: MemoryRow[]; total: number } {
		const rows = (
			this.db
				.prepare(
					`SELECT * FROM memories WHERE scope = ? AND kind != 'summary'
					  ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`,
				)
				.all(scope, Math.max(0, limit)) as Record<string, unknown>[]
		).map(toRow);
		const total = (this.db.prepare(`SELECT count(*) AS n FROM memories WHERE scope = ? AND kind != 'summary'`).get(scope) as { n: number }).n;
		return { rows, total };
	}

	stats(scopes?: string[]): { scope: string; count: number; pinned: number }[] {
		if (scopes && scopes.length > 0) {
			const placeholders = scopes.map(() => "?").join(", ");
			return (
				this.db
					.prepare(
						`SELECT scope, COUNT(*) AS count, SUM(pinned) AS pinned
						   FROM memories WHERE scope IN (${placeholders})
						  GROUP BY scope ORDER BY scope`,
					)
					.all(...scopes) as Record<string, unknown>[]
			).map((r) => ({ scope: String(r.scope), count: Number(r.count), pinned: Number(r.pinned ?? 0) }));
		}
		return (
			this.db
				.prepare(
					`SELECT scope, COUNT(*) AS count, SUM(pinned) AS pinned
					   FROM memories GROUP BY scope ORDER BY scope`,
				)
				.all() as Record<string, unknown>[]
		).map((r) => ({ scope: String(r.scope), count: Number(r.count), pinned: Number(r.pinned ?? 0) }));
	}
}

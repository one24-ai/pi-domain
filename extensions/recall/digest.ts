/**
 * The recall block: what the model is given about memories at the start of a session.
 *
 * It is an index, not the memories themselves. Short memories are listed whole; a long one by its
 * first sentence and its length, so the model can fetch the rest with memory_get when it matters.
 * The block has a character budget, global memories may use only a share of it, and a footer says
 * what was left out, so a cut is never silent.
 *
 * Free of pi imports so it can be tested on its own.
 */

import type { MemoryRow } from "./store.ts";

export interface DigestOptions {
	maxChars: number;
	maxItems: number;
	/** Share of maxChars unpinned global rows may use before project rows have had their turn, 0 to 1. */
	globalShare: number;
	inlineChars: number;
	/** Shown in the header, e.g. "project:foo". */
	projectScope: string;
}

export interface DigestInput {
	/** Project rows, pinned first then newest first. Summaries are expected to be left out already. */
	project: MemoryRow[];
	/** Global rows, in the same order. */
	global: MemoryRow[];
	/** Rows that match the session's first prompt, best first (either scope). Listed after pinned ones. */
	related?: MemoryRow[];
	/** How many recallable memories each scope holds in total (for the footer). */
	totals: { project: number; global: number };
}

export interface Digest {
	/** The text sent to the model; empty when there is nothing to recall. */
	text: string;
	/** Ids listed, in order. */
	ids: number[];
	/** Of those, the ids shortened to their first sentence. */
	shortened: number[];
	/** Recallable memories in the two scopes. */
	total: number;
	/** Pinned memories that did not fit. */
	pinnedLeftOut: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The first sentence of `text`, at most `max` characters, ending in "…" when cut. */
export function firstSentence(text: string, max: number): string {
	const flat = oneLine(text);
	const m = flat.match(/^.{20,}?[.!?](?=\s|$)/);
	const s = m ? m[0] : flat;
	return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}

/** One index line for a row. */
export function digestLine(row: MemoryRow, inlineChars: number): { line: string; shortened: boolean } {
	const label = `#${row.id} ${row.kind}${row.pinned ? ", pinned" : ""}`;
	const flat = oneLine(row.text);
	if (flat.length <= inlineChars) return { line: `${label}: ${flat}`, shortened: false };
	const head = firstSentence(flat, Math.max(40, Math.floor(inlineChars * 0.6)));
	return { line: `${label}: ${head} [${flat.length} chars]`, shortened: true };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Build the recall block. Order of preference: project pinned, global pinned, rows related to the
 * first prompt, project recent, global recent; each memory once. A line that does not fit is
 * skipped and the next one tried, so one long line does not stop shorter ones. Unpinned global
 * lines first stop at their share of the budget, then fill whatever the project left unused.
 */
export function buildDigest(input: DigestInput, opts: DigestOptions): Digest {
	const total = input.totals.project + input.totals.global;
	const empty: Digest = { text: "", ids: [], shortened: [], total, pinnedLeftOut: 0 };
	if (total === 0 || opts.maxItems === 0 || opts.maxChars === 0) {
		return { ...empty, pinnedLeftOut: [...input.project, ...input.global].filter((r) => r.pinned).length };
	}

	const header =
		`Memories from earlier sessions (${opts.projectScope} and global). Lines ending in [N chars] are shortened: ` +
		`memory_get gives the full text. memory_search finds memories not listed here.`;
	// Room for the footer, so adding it never breaks the budget.
	const footerRoom = 120;
	let budget = opts.maxChars - header.length - footerRoom;
	let globalBudget = Math.floor(opts.maxChars * opts.globalShare);

	const globalIds = new Set(input.global.map((r) => r.id));
	const seen = new Set<number>();
	const order: { row: MemoryRow; global: boolean }[] = [
		...input.project.filter((r) => r.pinned),
		...input.global.filter((r) => r.pinned),
		...(input.related ?? []),
		...input.project.filter((r) => !r.pinned),
		...input.global.filter((r) => !r.pinned),
	]
		.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
		.map((row) => ({ row, global: globalIds.has(row.id) || row.scope === "global" }));

	const lines: string[] = [];
	const ids: number[] = [];
	const shortened: number[] = [];
	const place = (row: MemoryRow, line: string, short: boolean, cost: number) => {
		lines.push(line);
		ids.push(row.id);
		if (short) shortened.push(row.id);
		budget -= cost;
	};
	// First pass: globals held to their share. Second pass: globals that were held back may use
	// what the project did not need.
	const heldBack: { row: MemoryRow; line: string; short: boolean; cost: number }[] = [];
	const skipped = new Set<number>();
	for (const { row, global } of order) {
		const { line, shortened: short } = digestLine(row, opts.inlineChars);
		const cost = line.length + 1;
		if (ids.length >= opts.maxItems || cost > budget) {
			skipped.add(row.id);
			continue;
		}
		// Pinned memories are always listed when they fit; the share only holds back the rest.
		if (global && !row.pinned && cost > globalBudget) {
			heldBack.push({ row, line, short, cost });
			continue;
		}
		place(row, line, short, cost);
		if (global) globalBudget -= cost;
	}
	for (const h of heldBack) {
		if (ids.length < opts.maxItems && h.cost <= budget) place(h.row, h.line, h.short, h.cost);
		else skipped.add(h.row.id);
	}
	const pinnedLeftOut = order.filter(({ row }) => row.pinned && skipped.has(row.id)).length;
	if (ids.length === 0) return { ...empty, pinnedLeftOut };

	const left = total - ids.length;
	const footer =
		left > 0
			? `${plural(left, "more memory", "more memories")} not listed${pinnedLeftOut > 0 ? `, ${plural(pinnedLeftOut, "pinned one")} among them` : ""}; use memory_search.`
			: "";
	const text = [header, "", ...lines, ...(footer ? ["", footer] : [])].join("\n");
	return { text, ids, shortened, total, pinnedLeftOut };
}

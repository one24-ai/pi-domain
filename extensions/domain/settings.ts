/**
 * pi-domain settings, read from pi-domain.json in pi's agent directory (~/.pi/agent unless pi
 * is told otherwise). Every key is optional; a missing file, a malformed file
 * or a value of the wrong type falls back to the default, so a typo never stops pi from starting.
 *
 *   {
 *     "recall":    { "maxChars": 4000, "maxItems": 20, "globalShare": 0.5, "inlineChars": 300 },
 *     "write":     { "warnChars": 600 },
 *     "summaries": { "save": true, "maxChars": 4000, "keep": 3 },
 *     "backup":    { "everyHours": 24, "keep": 20 }
 *   }
 *
 * Free of pi imports so it can be tested on its own.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RecallSettings {
	recall: {
		/** Characters of memories loaded at session start, header and footer included. */
		maxChars: number;
		/** Memories listed at session start, at most. */
		maxItems: number;
		/** Share of maxChars that global memories may use, 0 to 1; the rest is kept for the project. */
		globalShare: number;
		/** A memory up to this long is listed whole; a longer one by its first sentence. */
		inlineChars: number;
	};
	write: {
		/**
		 * memory_write and memory_update answer with a note above this many characters, and
		 * /memory-tidy suggests shortening such memories. Recall shortens anything over
		 * recall.inlineChars regardless.
		 */
		warnChars: number;
	};
	summaries: {
		/** Save each compaction summary as a "summary" memory (searchable, never recalled). */
		save: boolean;
		maxChars: number;
		/** /memory-tidy suggests deleting summaries beyond the newest this many per project. */
		keep: number;
	};
	backup: {
		/** Hours between automatic snapshots at session start; 0 turns them off. */
		everyHours: number;
		/** Snapshots kept; older ones are removed after a new one succeeds. */
		keep: number;
	};
}

export const DEFAULT_SETTINGS: RecallSettings = {
	recall: { maxChars: 4000, maxItems: 20, globalShare: 0.5, inlineChars: 300 },
	write: { warnChars: 600 },
	summaries: { save: true, maxChars: 4000, keep: 3 },
	backup: { everyHours: 24, keep: 20 },
};

/** pi-domain.json in pi's agent directory (pass pi's getAgentDir()). */
export function settingsPath(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "pi-domain.json");
}

type Bounds = { min: number; max: number; int?: boolean };

function num(v: unknown, fallback: number, b: Bounds): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	const n = b.int ? Math.round(v) : v;
	return Math.min(b.max, Math.max(b.min, n));
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Settings from parsed JSON, each value checked and clamped; anything unusable takes the default. */
export function parseSettings(raw: unknown): RecallSettings {
	const d = DEFAULT_SETTINGS;
	const r = obj(obj(raw).recall);
	const w = obj(obj(raw).write);
	const s = obj(obj(raw).summaries);
	const b = obj(obj(raw).backup);
	return {
		recall: {
			// Below about 500 the header and footer leave no room; 0 turns recall off.
			maxChars: r.maxChars === 0 ? 0 : num(r.maxChars, d.recall.maxChars, { min: 500, max: 100_000, int: true }),
			maxItems: num(r.maxItems, d.recall.maxItems, { min: 0, max: 200, int: true }),
			globalShare: num(r.globalShare, d.recall.globalShare, { min: 0, max: 1 }),
			inlineChars: num(r.inlineChars, d.recall.inlineChars, { min: 60, max: 10_000, int: true }),
		},
		write: { warnChars: num(w.warnChars, d.write.warnChars, { min: 0, max: 100_000, int: true }) },
		summaries: {
			save: typeof s.save === "boolean" ? s.save : d.summaries.save,
			maxChars: num(s.maxChars, d.summaries.maxChars, { min: 200, max: 100_000, int: true }),
			keep: num(s.keep, d.summaries.keep, { min: 0, max: 1000, int: true }),
		},
		backup: {
			everyHours: num(b.everyHours, d.backup.everyHours, { min: 0, max: 24 * 365 }),
			keep: num(b.keep, d.backup.keep, { min: 1, max: 1000, int: true }),
		},
	};
}

export interface LoadedSettings {
	settings: RecallSettings;
	path: string;
	/** Set when the file exists but could not be read or parsed. */
	error?: string;
}

export function loadSettings(path: string = settingsPath()): LoadedSettings {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: DEFAULT_SETTINGS, path };
		return { settings: DEFAULT_SETTINGS, path, error: (err as Error).message };
	}
	try {
		return { settings: parseSettings(JSON.parse(text)), path };
	} catch (err) {
		return { settings: DEFAULT_SETTINGS, path, error: `not valid JSON: ${(err as Error).message}` };
	}
}

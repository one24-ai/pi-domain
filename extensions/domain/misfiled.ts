/**
 * Finding memories filed under the wrong project.
 *
 * A session started in a folder that is not a git repository (a home folder, a scratch folder)
 * files its memories under that folder's name, whatever they are about. This looks for such
 * memories whose text names exactly one project that exists, so /memory-tidy can offer to move them.
 *
 * Free of pi imports so it can be tested on its own.
 */

import type { MemoryRow } from "./store.ts";

export interface Misfiled {
	row: MemoryRow;
	/** The project the text is about, as a scope. */
	to: string;
	/** What in the text pointed there. */
	evidence: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The start of a path into the repositories folder: ~/git/, $HOME/git/ or /home/<user>/git/. */
const GIT_DIR = "(?:~|\\$HOME|/home/[\\w.-]+)/git/";

/**
 * @param rows memories to look at
 * @param isFolderScope true for a scope that is only a folder name (not inside a git repository)
 * @param repos project names that exist (git directories), without the `project:` prefix
 *
 * A memory counts only when its scope is a plain folder and its text is plainly about one project:
 *  - it names exactly one existing project, by path (`~/git/kiln`, `~/git/org/kiln`) or as a bare
 *    name (not as a file name such as `kiln.yaml`);
 *  - and it names no other project-looking path or `pi-*` style name that does not exist (an old
 *    name or a repository since removed means the memory is about something else).
 * Several different projects, or none, mean no suggestion.
 */
export function findMisfiled(rows: MemoryRow[], isFolderScope: (scope: string) => boolean, repos: string[]): Misfiled[] {
	const known = new Set(repos);
	const names = [...new Set(repos)].filter((n) => n.length >= 4);
	const out: Misfiled[] = [];
	for (const row of rows) {
		if (row.kind === "summary" || !row.scope.startsWith("project:") || !isFolderScope(row.scope)) continue;
		const own = row.scope.slice("project:".length);
		const found = new Map<string, string>();
		for (const name of names) {
			if (name === own) continue;
			const path = new RegExp(`${GIT_DIR}(?:[\\w.-]+/)*${escape(name)}(?![\\w-])`).exec(row.text);
			// A bare name is not a file name (kiln.yaml) or part of another path.
			const bare = new RegExp(`(?<![\\w/.-])${escape(name)}(?![\\w-]|\\.\\w)`).exec(row.text);
			if (path) found.set(name, path[0]);
			else if (bare) found.set(name, bare[0]);
		}
		if (found.size !== 1) continue;
		// Another project in the text, by path or by a pi-style name, that is not a repo that exists:
		// the memory is about that (an old or removed project), so it is not clearly about this one.
		// A ~/git/<name> or ~/git/<org>/<name> path whose project is not one that exists.
		// Segments of a path into the git folder, without the full stop that ends a sentence.
		const seg = (v: string | undefined) => (v === undefined ? undefined : v.replace(/[.-]+$/, ""));
		const stray = [...row.text.matchAll(new RegExp(`${GIT_DIR}([\\w.-]+)(?:/([\\w.-]+))?`, "g"))]
			.filter((m) => ![seg(m[1]), seg(m[2])].some((name) => name !== undefined && known.has(name)))
			.map((m) => seg(m[1])!)
			.filter((n) => n.length >= 4 && n !== own);
		const strayNames = [...row.text.matchAll(/(?<![\w/.-])(pi-[a-z][\w-]*)(?![\w-])/g)].map((m) => m[1]!).filter((n) => !known.has(n) && n !== own);
		if (stray.length > 0 || strayNames.length > 0) continue;
		const [name, evidence] = [...found][0]!;
		out.push({ row, to: `project:${name}`, evidence });
	}
	return out;
}

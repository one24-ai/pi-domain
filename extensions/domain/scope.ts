/**
 * Scope resolution for pi-domain.
 *
 * A memory belongs to a scope so that recall is relevant: notes about one repo
 * should not surface while working in another. Scopes are resolved from the
 * working directory, preferring the git repository root so that `~/git/foo` and
 * `~/git/foo/packages/bar` share one memory space.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** Scope shared by every session regardless of directory. */
export const GLOBAL_SCOPE = "global";

/** Cache keyed by cwd: git invocation is cheap but not free, and cwd rarely changes. */
const scopeCache = new Map<string, string>();

function gitRoot(cwd: string): string | undefined {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
		const root = out.trim();
		return root.length > 0 ? root : undefined;
	} catch {
		// Not a repo, or git unavailable. Fall back to the directory itself.
		return undefined;
	}
}

/**
 * Project scope for a working directory: the git repo name when inside a repo,
 * otherwise the directory basename. Prefixed to avoid colliding with "global".
 */
export function resolveProjectScope(cwd: string): string {
	const key = resolve(cwd);
	const cached = scopeCache.get(key);
	if (cached) return cached;

	const root = gitRoot(key);
	const scope = `project:${basename(root ?? key)}`;
	scopeCache.set(key, scope);
	return scope;
}

/**
 * Scopes to read from, most specific first. Callers pass this straight to
 * MemoryStore.search / recall.
 */
export function resolveReadScopes(cwd: string): string[] {
	return [resolveProjectScope(cwd), GLOBAL_SCOPE];
}

/** Clear the cwd cache. Used by tests and after a reload. */
export function clearScopeCache(): void {
	scopeCache.clear();
}

/** True when `cwd` is inside a git repository (so its scope is a real project, not just a folder). */
export function isInGitRepo(cwd: string): boolean {
	return gitRoot(resolve(cwd)) !== undefined;
}

export type ResolvedProject = { scope: string } | { error: string };

const isDir = (p: string): boolean => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const MAX_LISTED = 8;

/**
 * Turn a project the model names into a scope, for work done from a folder that is not the
 * project (a home folder, a scratch folder). Accepts:
 *  - a project already known (it has memories): `kiln` or `project:kiln`, exact or in any case;
 *  - a path to a directory that exists (`~/git/kiln`, `../kiln`), which is how a project with no
 *    memories yet is started; its scope is the git repository name, as it would be from inside it.
 * Anything else is refused, with the known projects listed, so a typo cannot start a new scope.
 *
 * @param known scopes that hold memories (as `project:<name>`)
 */
export function resolveProject(input: string, cwd: string, known: string[], home: string = homedir()): ResolvedProject {
	const raw = input.trim();
	if (!raw) return { error: "project is empty" };
	if (raw === GLOBAL_SCOPE) return { error: 'use global: true for the global scope, not project: "global"' };

	const projects = known.filter((k) => k.startsWith("project:"));
	const looksLikePath = /[\\/]/.test(raw) || raw.startsWith("~") || raw.startsWith(".");
	if (looksLikePath) {
		const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
		const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
		if (!isDir(abs)) return { error: `${raw} is not a directory${abs === raw ? "" : ` (looked at ${abs})`}` };
		return { scope: resolveProjectScope(abs) };
	}

	const name = raw.startsWith("project:") ? raw.slice("project:".length) : raw;
	const wanted = `project:${name}`;
	const exact = projects.find((k) => k === wanted) ?? (resolveProjectScope(cwd) === wanted ? wanted : undefined);
	if (exact) return { scope: exact };
	const loose = projects.filter((k) => k.toLowerCase() === wanted.toLowerCase());
	if (loose.length === 1) return { scope: loose[0]! };

	const names = projects.map((k) => k.slice("project:".length)).sort();
	const list = names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more` : names.join(", ");
	return {
		error: `no project named ${name} has memories${list ? ` (known: ${list})` : ""}. To start one, pass its directory as a path, such as ~/git/${name}`,
	};
}

/**
 * Git repositories under the given roots, one level down (`~/git/<repo>`) and two (`~/git/<org>/<repo>`):
 * name to directory. The first one found wins when two share a name. A root that does not exist is skipped.
 */
export function findRepos(roots: string[]): Map<string, string> {
	const found = new Map<string, string>();
	const subdirs = (dir: string): string[] => {
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith("."))
				.map((d) => join(dir, d.name));
		} catch {
			return [];
		}
	};
	for (const root of roots) {
		for (const a of subdirs(root)) {
			if (existsSync(join(a, ".git"))) {
				if (!found.has(basename(a))) found.set(basename(a), a);
				continue;
			}
			for (const b of subdirs(a)) if (existsSync(join(b, ".git")) && !found.has(basename(b))) found.set(basename(b), b);
		}
	}
	return found;
}

/** Where repositories are looked for by default: ~/git, or $PI_DOMAIN_REPOS (a colon-separated list). */
export function defaultRepoRoots(env: Record<string, string | undefined> = process.env, home: string = homedir()): string[] {
	const custom = env.PI_DOMAIN_REPOS?.split(":").filter(Boolean);
	return custom && custom.length > 0 ? custom : [join(home, "git")];
}

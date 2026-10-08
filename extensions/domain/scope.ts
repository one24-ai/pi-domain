/**
 * Scope resolution for pi-domain.
 *
 * A memory belongs to a scope so that recall is relevant: notes about one repo
 * should not surface while working in another. Scopes are resolved from the
 * working directory, preferring the git repository root so that `~/git/foo` and
 * `~/git/foo/packages/bar` share one memory space.
 */

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

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

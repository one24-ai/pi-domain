import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearScopeCache, defaultRepoRoots, findRepos, resolveProject, resolveProjectScope } from "../extensions/domain/scope.ts";

function tree() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-domain-scope-")));
	const repo = (path: string) => {
		mkdirSync(join(root, path), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: join(root, path) });
	};
	repo("git/kiln");
	repo("git/org/tools");
	repo("git/shared");
	mkdirSync(join(root, "git", "notes"), { recursive: true }); // a folder, not a repository
	mkdirSync(join(root, "scratch"), { recursive: true });
	clearScopeCache();
	return { root, home: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const known = ["global", "project:kiln", "project:Pi-Halo", "project:home"];

test("a known project resolves by name, with or without the prefix, exactly or ignoring case", () => {
	const t = tree();
	try {
		const cwd = join(t.root, "scratch");
		assert.deepEqual(resolveProject("kiln", cwd, known, t.home), { scope: "project:kiln" });
		assert.deepEqual(resolveProject("project:kiln", cwd, known, t.home), { scope: "project:kiln" });
		assert.deepEqual(resolveProject("pi-halo", cwd, known, t.home), { scope: "project:Pi-Halo" });
		assert.deepEqual(resolveProject("  kiln ", cwd, known, t.home), { scope: "project:kiln" });
	} finally {
		t.cleanup();
	}
});

test("this folder's own project always resolves, even before it has memories", () => {
	const t = tree();
	try {
		assert.deepEqual(resolveProject("kiln", join(t.root, "git", "kiln"), [], t.home), { scope: "project:kiln" });
	} finally {
		t.cleanup();
	}
});

test("a directory resolves to its repository's name, which is how a new project is started", () => {
	const t = tree();
	try {
		const cwd = join(t.root, "scratch");
		assert.deepEqual(resolveProject("~/git/kiln", cwd, [], t.home), { scope: "project:kiln" });
		assert.deepEqual(resolveProject("~/git/org/tools", cwd, [], t.home), { scope: "project:tools" });
		assert.deepEqual(resolveProject(join(t.root, "git", "shared", "."), cwd, [], t.home), { scope: "project:shared" });
		assert.deepEqual(resolveProject("../git/kiln", cwd, [], t.home), { scope: "project:kiln" });
		assert.deepEqual(resolveProject("~/git/notes", cwd, [], t.home), { scope: "project:notes" }, "a plain folder is its own name");
	} finally {
		t.cleanup();
	}
});

test("a typo or a missing directory is refused with the known projects listed", () => {
	const t = tree();
	try {
		const cwd = join(t.root, "scratch");
		const typo = resolveProject("kilm", cwd, known, t.home);
		assert.ok("error" in typo);
		assert.match(typo.error, /no project named kilm has memories \(known: Pi-Halo, home, kiln\)/);
		assert.match(typo.error, /pass its directory as a path, such as ~\/git\/kilm/);
		const missing = resolveProject("~/git/nope", cwd, known, t.home);
		assert.ok("error" in missing);
		assert.match(missing.error, /not a directory/);
		assert.ok("error" in resolveProject("", cwd, known, t.home));
		const g = resolveProject("global", cwd, known, t.home);
		assert.ok("error" in g);
		assert.match(g.error, /global: true/);
	} finally {
		t.cleanup();
	}
});

test("a long list of known projects is cut", () => {
	const many = Array.from({ length: 20 }, (_, i) => `project:p${String(i).padStart(2, "0")}`);
	const r = resolveProject("zzz", "/tmp", many, "/home/u");
	assert.ok("error" in r);
	assert.match(r.error, /known: p00, p01, p02, p03, p04, p05, p06, p07 and 12 more/);
});

test("findRepos finds repositories one and two levels down and skips plain folders", () => {
	const t = tree();
	try {
		const found = findRepos([join(t.root, "git"), join(t.root, "missing")]);
		assert.deepEqual([...found.keys()].sort(), ["kiln", "shared", "tools"]);
		assert.equal(found.get("tools"), join(t.root, "git", "org", "tools"));
		assert.equal(resolveProjectScope(join(t.root, "git", "org", "tools")), "project:tools");
	} finally {
		t.cleanup();
	}
});

test("repository roots default to ~/git and can be set with PI_DOMAIN_REPOS", () => {
	assert.deepEqual(defaultRepoRoots({}, "/home/u"), ["/home/u/git"]);
	assert.deepEqual(defaultRepoRoots({ PI_DOMAIN_REPOS: "/a:/b/c" }, "/home/u"), ["/a", "/b/c"]);
	assert.deepEqual(defaultRepoRoots({ PI_DOMAIN_REPOS: "" }, "/home/u"), ["/home/u/git"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { findMisfiled } from "../extensions/domain/misfiled.ts";
import type { MemoryRow } from "../extensions/domain/store.ts";

let id = 1;
const row = (text: string, o: Partial<MemoryRow> = {}): MemoryRow => ({ id: id++, scope: "project:home", kind: "fact", text, tags: [], pinned: false, createdAt: 0, updatedAt: 0, sessionId: null, ...o });
const repos = ["kiln", "pi-halo", "pi-domain", "glean-bridge", "app", "tools"];
const folder = (scope: string) => scope === "project:home" || scope === "project:zach";

test("a memory in a folder scope that names one project by path is offered a move", () => {
	const r = row("The executor contract lives in ~/git/kiln under docs/design.md.");
	assert.deepEqual(findMisfiled([r], folder, repos).map((m) => [m.row.id, m.to, m.evidence]), [[r.id, "project:kiln", "~/git/kiln"]]);
	const nested = row("See /home/zach/git/riot/tools for the build.");
	assert.equal(findMisfiled([nested], folder, repos)[0]?.to, "project:tools");
});

test("a bare name counts when it stands alone, not inside another word or path", () => {
	assert.equal(findMisfiled([row("kiln needs a retry policy.")], folder, repos)[0]?.to, "project:kiln");
	assert.equal(findMisfiled([row("Reached via glean-bridge's CDP port.")], folder, repos)[0]?.to, "project:glean-bridge");
	assert.deepEqual(findMisfiled([row("the kilnwork pattern"), row("a my-kiln-like thing"), row("pi-halo-riot is separate")], folder, repos), []);
});

test("short names are never matched by bare word, so ordinary words do not misfile", () => {
	assert.deepEqual(findMisfiled([row("Zach prefers this app to be small.")], folder, ["app", "kiln"]), []);
});

test("two projects, or none, give no suggestion", () => {
	assert.deepEqual(findMisfiled([row("Both kiln and pi-halo use this.")], folder, repos), []);
	assert.deepEqual(findMisfiled([row("Nothing about any project here.")], folder, repos), []);
});

test("memories already in a real project, summaries, and ones naming their own scope are left alone", () => {
	assert.deepEqual(findMisfiled([row("Uses ~/git/kiln", { scope: "project:pi-halo" })], folder, repos), []);
	assert.deepEqual(findMisfiled([row("Uses ~/git/kiln", { kind: "summary" })], folder, repos), []);
	assert.deepEqual(findMisfiled([row("Uses ~/git/kiln", { scope: "global" })], folder, repos), []);
	assert.deepEqual(findMisfiled([row("About home.", { scope: "project:home" })], folder, [...repos, "home"]), []);
});

test("regex characters in project names are taken literally", () => {
	assert.equal(findMisfiled([row("Work in ~/git/a.b-tools today")], folder, ["a.b-tools"])[0]?.to, "project:a.b-tools");
	assert.deepEqual(findMisfiled([row("Work in ~/git/axb-tools today")], folder, ["a.b-tools"]), []);
});

test("text that also names a project that no longer exists is left alone", () => {
	assert.deepEqual(findMisfiled([row("pi-workflow lives in ~/git/pi-workflow and hands work to ~/git/kiln.")], folder, repos), [], "a removed repo by path");
	assert.deepEqual(findMisfiled([row("pi-paneltui was renamed; kiln still uses its widgets.")], folder, repos), [], "an old pi-style name");
	assert.equal(findMisfiled([row("pi-halo and pi-domain are separate; see ~/git/kiln.")], folder, repos).length, 0, "two projects that exist");
	assert.equal(findMisfiled([row("See ~/git/kiln/docs for details.")], folder, repos)[0]?.to, "project:kiln", "a plain mention still counts");
});

test("only paths into the git folder count, and file names are not project names", () => {
	assert.deepEqual(findMisfiled([row("The unit lives at ~/.pi/agent/extensions/kiln.ts")], folder, repos), [], "a path outside ~/git");
	assert.deepEqual(findMisfiled([row("Config is in kiln.yaml and kiln.db")], folder, repos), [], "file names");
	assert.equal(findMisfiled([row("Kiln, the kiln. And kiln: yes")], folder, repos)[0]?.to, "project:kiln", "punctuation after the name is fine");
});

test("a removed repository named by a /home or $HOME path rules the memory out", () => {
	assert.deepEqual(findMisfiled([row("Moved from /home/zach/git/old-thing to ~/git/kiln.")], folder, repos), []);
	assert.deepEqual(findMisfiled([row("Moved from $HOME/git/old-thing to ~/git/kiln.")], folder, repos), []);
	assert.equal(findMisfiled([row("Work in /home/zach/git/kiln today.")], folder, repos)[0]?.to, "project:kiln");
});

test("a path that ends a sentence is still the project", () => {
	for (const t of ["First: see ~/git/kiln.", "Run it in ~/git/kiln, then stop.", "(see ~/git/kiln)", "in ~/git/kiln!"]) {
		assert.equal(findMisfiled([row(t)], folder, repos)[0]?.to, "project:kiln", t);
	}
	assert.deepEqual(findMisfiled([row("It lives in ~/git/old-thing. Also ~/git/kiln.")], folder, repos), [], "a removed repo still rules it out");
});

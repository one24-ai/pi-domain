import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, settingsPath } from "../extensions/domain/settings.ts";

test("no file: the defaults, and no error", () => {
	const r = loadSettings(join(tmpdir(), "pi-domain-none", "pi-domain.json"));
	assert.deepEqual(r.settings, DEFAULT_SETTINGS);
	assert.equal(r.error, undefined);
});

test("values are taken, clamped and type-checked one by one", () => {
	assert.equal(DEFAULT_SETTINGS.summaries.save, false, "summaries are not saved unless asked for");
	const s = parseSettings({
		recall: { maxChars: 2500, maxItems: 1000, globalShare: 2, inlineChars: "big" },
		write: { warnChars: -5 },
		summaries: { save: true, keep: 1.6 },
		backup: { everyHours: 0 },
		other: 1,
	});
	assert.equal(s.recall.maxChars, 2500);
	assert.equal(s.recall.maxItems, 200, "clamped to the maximum");
	assert.equal(s.recall.globalShare, 1, "clamped to 1");
	assert.equal(s.recall.inlineChars, DEFAULT_SETTINGS.recall.inlineChars, "wrong type: default");
	assert.equal(s.write.warnChars, 0, "clamped to 0, which turns the warning off");
	assert.equal(s.summaries.save, true);
	assert.equal(s.summaries.keep, 2, "rounded");
	assert.equal(s.summaries.maxChars, DEFAULT_SETTINGS.summaries.maxChars, "missing: default");
	assert.equal(s.backup.everyHours, 0);
	assert.equal(s.backup.keep, DEFAULT_SETTINGS.backup.keep);
});

test("anything that is not an object is the defaults", () => {
	for (const raw of [null, 3, "x", [], { recall: [] }]) assert.deepEqual(parseSettings(raw), DEFAULT_SETTINGS);
});

test("a malformed file gives the defaults and says why", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-domain-settings-"));
	try {
		const path = join(dir, "pi-domain.json");
		writeFileSync(path, "{ recall: ");
		const r = loadSettings(path);
		assert.deepEqual(r.settings, DEFAULT_SETTINGS);
		assert.match(r.error ?? "", /not valid JSON/);
		writeFileSync(path, JSON.stringify({ recall: { maxChars: 1234 } }));
		assert.equal(loadSettings(path).settings.recall.maxChars, 1234);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the file lives in pi's agent directory", () => {
	assert.equal(settingsPath("/cfg"), "/cfg/pi-domain.json");
});

test("a recall budget too small for the header is raised; 0 turns recall off", () => {
	assert.equal(parseSettings({ recall: { maxChars: 100 } }).recall.maxChars, 500);
	assert.equal(parseSettings({ recall: { maxChars: 0 } }).recall.maxChars, 0);
});

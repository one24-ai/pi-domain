/**
 * Run with:
 *   pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { haloLoaded } from "../extensions/domain/halo.ts";
import { plainRecallRow, recallRenderer, RECALL_ICON } from "../extensions/domain/recall-row.ts";

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as any;
const msg = (count = 2, content = "line one\nline two") => ({ customType: "memory-recall", content, display: true, details: { count } }) as any;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const opts = (expanded: boolean) => ({ expanded, outputPad: 1 });
/** The rendered lines of a row, failing loudly if the renderer gave nothing back. */
const draw = (row: { render: (w: number) => string[] } | undefined, width: number) => {
	assert.ok(row, "the renderer returned a component");
	return row.render(width).map(strip);
};

test("haloLoaded looks only for the registry symbol with a register function", () => {
	const key = Symbol.for("pi-halo/registry");
	assert.equal(haloLoaded({}), false);
	assert.equal(haloLoaded({ [key]: {} }), false);
	assert.equal(haloLoaded({ [key]: { register: () => {} } }), true);
});

test("with halo: one plain row with the icon, the title and the count on the right", () => {
	const lines = draw(recallRenderer({ halo: () => true, expandHint: () => "HINT" })(msg(2), opts(false), theme), 60);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]!.includes(RECALL_ICON));
	assert.match(lines[0]!, /Recall\s+session memories\s+2 memories$/);
	assert.ok(!lines[0]!.includes("HINT"));
});

test("with halo, expanded: the list appears under the row, indented", () => {
	const lines = draw(plainRecallRow(msg(2), opts(true), theme), 60);
	assert.equal(lines.length, 3);
	assert.match(lines[1]!, /^\s{3}line one/);
});

test("the count is singular for one memory", () => {
	const line = draw(plainRecallRow(msg(1), opts(false), theme), 60)[0]!;
	assert.match(line, /1 memory$/);
});

test("a narrow width truncates instead of overflowing", () => {
	for (const w of [8, 20, 30]) for (const l of draw(plainRecallRow(msg(12), opts(false), theme), w)) assert.ok(l.length <= w, `width ${w}: ${l.length}`);
});

test("without halo: pi's standard box, collapsed with the expand hint", () => {
	const text = draw(recallRenderer({ halo: () => false, expandHint: () => "ctrl+o to expand" })(msg(3), opts(false), theme), 80).join("\n");
	assert.match(text, /\[memory-recall\] 3 memories recalled ctrl\+o to expand/);
	assert.ok(!text.includes("line one"));
});

test("without halo, expanded: the list is in the box and the hint is gone", () => {
	const text = draw(recallRenderer({ halo: () => false, expandHint: () => "HINT" })(msg(2), opts(true), theme), 80).join("\n");
	assert.ok(text.includes("line one") && text.includes("line two"));
	assert.ok(!text.includes("HINT"));
});

test("the choice is made on each draw, so loading halo later changes the look", () => {
	let loaded = false;
	const render = recallRenderer({ halo: () => loaded, expandHint: () => "H" });
	assert.match(draw(render(msg(), opts(false), theme), 80).join("\n"), /\[memory-recall\]/);
	loaded = true;
	assert.ok(!draw(render(msg(), opts(false), theme), 80).join("\n").includes("[memory-recall]"));
});

test("content given as blocks instead of a string is read too", () => {
	const m = msg(1);
	m.content = [{ type: "text", text: "from blocks" }, { type: "image" }];
	const lines = draw(plainRecallRow(m, opts(true), theme), 60);
	assert.ok(lines.some((l) => l.includes("from blocks")));
});

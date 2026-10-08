#!/usr/bin/env node
/**
 * How many characters the memory tools add to every model request: each tool's name,
 * description and parameter schema, plus its prompt snippet and guidelines.
 *
 *   node --experimental-strip-types --no-warnings scripts/measure-tools.mjs
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "domain", "index.ts");
const mod = await import(entry);
const tools = [];
const pi = new Proxy({}, { get: (_, k) => (k === "registerTool" ? (t) => tools.push(t) : () => () => {}) });
mod.default(pi);
let total = 0;
for (const t of tools) {
	const n =
		JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length +
		(t.promptSnippet?.length ?? 0) +
		(t.promptGuidelines ?? []).join("\n").length;
	total += n;
	console.log(`${t.name.padEnd(14)} ${n}`);
}
console.log(`${"total".padEnd(14)} ${total}`);

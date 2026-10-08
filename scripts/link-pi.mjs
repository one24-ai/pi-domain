#!/usr/bin/env node
/**
 * Link the pi packages of the installed pi into node_modules, so tests and the type checker
 * resolve @earendil-works/* without downloading them. pi supplies these to extensions at runtime;
 * they are not dependencies of this package. Re-run after a pi update.
 *
 *   node scripts/link-pi.mjs [TARGET_DIR]
 *
 * TARGET_DIR defaults to this package.
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Every `pi` on PATH, in order: wrapper shims (such as pkgsrc's) that resolve the real pi at
// run time come first, so try each until one leads to the package.
const piBins = (process.env.PATH ?? "")
	.split(":")
	.filter(Boolean)
	.map((d) => join(d, "pi"))
	.filter((p) => {
		try {
			return statSync(p).isFile();
		} catch {
			return false;
		}
	});

/** Follow pnpm shims (`exec node "$basedir/…/pi-coding-agent/dist/…"`) to the package dir. */
function findAgent(bin) {
	let path = realpathSync(bin);
	for (let hop = 0; hop < 5; hop++) {
		const text = readFileSync(path, "utf8");
		const m = text.match(/"\$basedir\/([^"]*?\/@earendil-works\/pi-coding-agent)\/dist\//);
		if (m) return realpathSync(resolve(dirname(path), m[1]));
		const next = text.match(/exec\s+"([^"]+\/pi)"/)?.[1];
		if (!next) break;
		path = realpathSync(next);
	}
	let d = dirname(realpathSync(bin));
	while (d !== "/") {
		const c = join(d, "node_modules", "@earendil-works", "pi-coding-agent");
		if (existsSync(join(c, "package.json"))) return realpathSync(c);
		d = dirname(d);
	}
	throw new Error(`could not locate pi-coding-agent from ${bin}`);
}

let agent;
for (const bin of piBins) {
	try {
		agent = findAgent(bin);
		break;
	} catch {
		// a shim; try the next pi on PATH
	}
}
if (!agent) throw new Error(`could not locate pi-coding-agent from: ${piBins.join(", ") || "no pi on PATH"}`);
const scope = dirname(agent);
const outScope = join(root, "node_modules", "@earendil-works");
mkdirSync(outScope, { recursive: true });
for (const name of ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"]) {
	const src = realpathSync(join(scope, name));
	const dst = join(outScope, name);
	try {
		if (readlinkSync(dst) === src) continue;
	} catch {
		// missing or not a link
	}
	rmSync(dst, { recursive: true, force: true });
	symlinkSync(src, dst);
	console.log(`linked ${name} -> ${src}`);
}

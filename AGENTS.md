# pi-recall: notes for agents working in this repo

- A general-purpose package. Nothing specific to one company, its hosts, services or tools goes in code, docs, tests or examples.
- Use pnpm, never npm or yarn. `pnpm check` runs the tests and the type check; run it before saying a change is done.
- Every change a user could notice gets a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit. Say if it is breaking.
- Context is the product: anything sent to the model on every request (tool descriptions, parameters, guidelines) or every conversation (recall) has a measured budget. `node --experimental-strip-types scripts/measure-tools.mjs` prints the tool cost and `test/extension.test.ts` holds a ceiling; raise it only on purpose.
- pi-halo is optional. Never import it; talk to it only through the globals documented in `extensions/recall/halo.ts`.
- No em dashes anywhere.

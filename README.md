# pi-domain

Persistent memory for [pi](https://pi.dev). The model saves decisions, preferences, facts and gotchas as it works; the next session starts with a short index of them, and anything else is a search away. Everything stays in one SQLite file on your machine.

Named after the Domain, the Forerunners' store of knowledge and ancestral memory in the Halo universe.

Requires pi 1.1 and Node.js 22.19 or later (for `node:sqlite`).

```bash
pi install npm:pi-domain@0.1.0                        # from npm, pinned
pi install git:github.com/one24-ai/pi-domain@v0.1.0   # from git, pinned to a tag
pi install /path/to/pi-domain                         # a local checkout
```

## How it works

**Saving.** The model has five tools:

| Tool | What it does |
|---|---|
| `memory_write` | Save a memory: `decision`, `preference`, `fact`, `gotcha`. Project scope by default, `global` for facts that hold everywhere, `pinned` to always recall it. Saving the same text again refreshes it instead of adding a copy. Text over 600 characters gets a note asking for the key point first. |
| `memory_update` | Change a memory by id: text, kind, tags, pin or scope. Used instead of piling up corrections. |
| `memory_search` | Full-text search of this project's and global memories. Long ones come back as their first sentence and length. |
| `memory_get` | The full text of memories by id. |
| `memory_forget` | Delete a memory by id. You confirm every deletion; without an interactive UI nothing is deleted. |

**Recall.** With the first prompt of a session, the model gets an index of memories:

```
Memories from earlier sessions (project:my-app and global). Lines ending in [N chars] are shortened: memory_get gives the full text. memory_search finds memories not listed here.

#12 decision, pinned: Use pnpm, never npm or yarn.
#31 gotcha: The integration tests need TZ=UTC; they fail in other time zones.
#40 fact: The deploy has three steps, run in order from the repo root. [1830 chars]

14 more memories not listed; use memory_search.
```

- It fits a character budget (4,000 by default, about 1,000 tokens), lists at most 20 memories, and says how many it left out.
- Order: pinned memories, then memories that share distinctive words with your first prompt, then the most recent.
- A memory up to 300 characters is shown whole. A longer one is shown by its first sentence and its length, so the model can fetch it when it matters.
- Global memories may use half the budget at first, then whatever the project left unused, so a long global list never crowds out the project.
- It is sent once per conversation. Reloading, resuming or forking a session does not add it again. After compaction has summarised it away, the next prompt brings a fresh one.
- Compaction summaries are never recalled. They are kept as `summary` memories you can search.

**Scopes.** A memory belongs to the git repository it was saved in (`project:<repo name>`, the directory name outside a repository) or to `global`. A session sees its project and global, nothing else.

**Snapshots.** At session start, a snapshot of the database is taken when the newest one is a day old. `/memory-backup` takes one now and `/memory-restore` puts one back (after saving the current state, so a restore can be undone). The newest 20 are kept.

## Commands

| Command | |
|---|---|
| `/memory [words]` | List or search memories, with counts per scope and the size of this session's recall |
| `/memory-pin <id>` | Pin or unpin a memory |
| `/memory-forget <id>` | Delete a memory, after you confirm |
| `/memory-tidy` | Step through cleanup suggestions: memories that say they supersede others, near-duplicates, "Extends #N" notes to fold in, memories over 600 characters, and old compaction summaries. You choose for each: delete, keep, or ask the agent to merge or shorten |
| `/memory-backup` | Save a checked snapshot now |
| `/memory-restore [name]` | Replace all memories with a snapshot, after you confirm |

## Settings

Optional. Put any of these in `~/.pi/agent/pi-domain.json` (or `$PI_CODING_AGENT_DIR/pi-domain.json`). Values are read at session start, checked and clamped; a missing or malformed file means the defaults, with a warning for a malformed one.

```json
{
  "recall": { "maxChars": 4000, "maxItems": 20, "globalShare": 0.5, "inlineChars": 300 },
  "write": { "warnChars": 600 },
  "summaries": { "save": true, "maxChars": 4000, "keep": 3 },
  "backup": { "everyHours": 24, "keep": 20 }
}
```

| Key | Default | |
|---|---|---|
| `recall.maxChars` | 4000 | Size of the recall index, in characters. 0 turns recall off |
| `recall.maxItems` | 20 | Memories listed at most |
| `recall.globalShare` | 0.5 | Share of the budget global memories get before the project has had its turn |
| `recall.inlineChars` | 300 | Memories up to this long are shown whole, in recall and in search results |
| `write.warnChars` | 600 | Saving longer text gets a note; `/memory-tidy` suggests shortening. 0 turns both off |
| `summaries.save` | true | Keep compaction summaries as `summary` memories |
| `summaries.maxChars` | 4000 | Longer summaries are cut |
| `summaries.keep` | 3 | `/memory-tidy` suggests deleting older summaries beyond this many per project |
| `backup.everyHours` | 24 | Hours between automatic snapshots. 0 turns them off |
| `backup.keep` | 20 | Snapshots kept |

The database is `$XDG_DATA_HOME/pi-domain/domain.db`, else `~/.local/share/pi-domain/domain.db`, with snapshots in `backups/` beside it. `PI_DOMAIN_DB=/path/to/file.db` uses another file (its snapshots go beside it too).

## What it costs

The tools add about 2,750 characters (roughly 700 tokens) to every request: their names, descriptions and parameters (`node --experimental-strip-types scripts/measure-tools.mjs` prints the figure). Recall adds up to `recall.maxChars` once per conversation. Search results are capped at 30 memories and shortened; `memory_get` returns at most 16,000 characters per call.

## Privacy

pi-domain makes no network requests. Memories are stored in the SQLite file above and are sent only to the model you use, as part of the conversation, like anything else in it. Do not ask it to remember secrets. To remove everything, delete the `pi-domain` data directory.

## With pi-halo

pi-domain works the same with or without [pi-halo](https://github.com/one24-ai/pi-halo), and neither package depends on the other. When halo is loaded:

- the memory tools are drawn as halo's one-line rows (`󰧑 Remember fact Use pnpm…   #12 saved`),
- the recall message is one plain row (`󰧑 Recall session memories   17 of 32 memories`), expanding to the index,
- a Memory section in the sidebar shows the recall size (`17/32 · 3.8K/4.0K`: memories listed of those that could be, characters used of the budget) and the memories saved or changed in this session; click one to read it.

Without halo, pi-domain draws its own compact tool rows and a boxed recall message, and shows no sidebar. The pairing goes through the documented globals halo leaves on `globalThis` (see `extensions/domain/halo.ts`), so the two can be installed, updated and removed separately.

## Development

```bash
pnpm install
pnpm check      # tests and type check, against the pi installed on your PATH
```

The tests link the installed pi's packages into `node_modules` (`scripts/link-pi.mjs`) instead of downloading them. Changes go in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`; releases are described in [RELEASING.md](RELEASING.md).

## Versioning

[Semantic Versioning](https://semver.org). The public API is the tool names and parameters, the commands, the settings file, the environment variable and the database schema (a schema change comes with a migration). Before 1.0.0, a breaking change bumps the minor version.

## License

MIT

## Trademarks

Halo is a trademark of Microsoft Corporation. pi-domain is an independent project, not affiliated with or endorsed by Microsoft, Xbox Game Studios or Halo Studios; the name is a nod to the fiction and the package uses no Halo artwork, code or game content.

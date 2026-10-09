# Changelog

All notable changes to pi-domain are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.3.0]

### Changed

- Compaction summaries are no longer saved as memories by default (`summaries.save` now defaults to `false`). A stored summary was a cut-down snapshot of one moment that went stale, and pi already keeps every summary in the session file. Set `summaries.save` to `true` in `pi-domain.json` to keep the old behaviour. Summaries already saved stay, and `/memory-tidy` still offers to delete old ones. Breaking for anyone relying on the default.

## [0.2.0]

### Added

- An optional `project` argument on `memory_write`, `memory_update`, `memory_search`, `memory_get` and `memory_forget`, for work done from a folder that is not the project (a home folder, a scratch folder). It takes the name of a project that has memories, or a directory; a name that matches nothing is refused with the known projects listed. `memory_update` moves a memory with `project` (or `global`) and reaches one in another project with `in`, never moving it by accident; replies say when a memory was filed outside the folder's project.
- `/memory-tidy` offers to move memories filed under a folder that name exactly one existing project (and no removed or renamed one), or to make them global. `/memory-tidy all` covers every project, and the command starts with a count of what it found and ends with what it did.
- `PI_DOMAIN_REPOS` sets where `/memory-tidy` looks for repositories (default `~/git`).

### Changed

- The tool definitions grew from about 2,750 to 3,300 characters for the `project` argument.

## [0.1.1]

### Changed

- Published through GitHub Actions with npm trusted publishing and provenance. No code changes since 0.1.0.

## [0.1.0]

First public release.

### Added

- Tools for the model: `memory_write`, `memory_update`, `memory_search`, `memory_get` and `memory_forget` (each deletion confirmed by the user), with read-only and destructive hints for permission extensions.
- Recall: a budgeted index of memories (pinned, related to the first prompt, then recent) sent with the first prompt of a conversation, never repeated by a reload, resume or fork, and sent again after compaction.
- Long memories are shown by their first sentence and length in recall and search; `memory_get` returns them in full.
- Saving text over 600 characters returns a note; `/memory-tidy` suggests shortening long memories.
- Compaction summaries kept as searchable `summary` memories.
- Commands: `/memory`, `/memory-pin`, `/memory-forget`, `/memory-tidy`, `/memory-backup`, `/memory-restore`.
- Daily snapshots at session start, checked before they count.
- Settings in `pi-domain.json`.
- Optional pi-halo pairing: halo tool rows, a plain recall row and a sidebar section, through halo's globals only.

[Unreleased]: https://github.com/one24-ai/pi-domain/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/one24-ai/pi-domain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/one24-ai/pi-domain/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/one24-ai/pi-domain/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/one24-ai/pi-domain/releases/tag/v0.1.0

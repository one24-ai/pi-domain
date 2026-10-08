# Changelog

All notable changes to pi-recall are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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
- Settings in `pi-recall.json`.
- Optional pi-halo pairing: halo tool rows, a plain recall row and a sidebar section, through halo's globals only.

[Unreleased]: https://github.com/one24-ai/pi-recall/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/one24-ai/pi-recall/releases/tag/v0.1.0

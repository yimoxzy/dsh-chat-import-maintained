# Upstream and maintained fork

This is **dsh-chat-import-maintained**, an independently maintained fork of [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import), released under the original MIT license. Preserve LICENSE and the original copyright notices when redistributing.

- Upstream baseline: `c6097b3` (`0.26.5`).
- Maintained release: `0.27.0-maintained.1`.
- Branch: `maintained/codex-projects`.
- Distribution identity: `dsh-chat-import-maintained`. This checkout has not been published to npm or pushed to a personal Git hosting account.
- The original Git remote is named `upstream` for fetching updates. Set your own repository as `origin` before publishing; see [maintenance guide](docs/MAINTAINING.zh-CN.md).

## Intent

Keep upstream's existing format adapters and add a dedicated Codex project migration entry. The project entry reads desktop SQLite history plus JSONL fallback, retains source names and complete history, and verifies native projections, workspaces and sidebar list notifications. It uses a separate migration ledger and never changes Codex source files or rewrites a previously imported conversation.

The upstream and maintained packages expose overlapping tools, routes and UI. **Enable only one at a time.** Existing upstream import records are preserved. The new Codex project ledger does not silently adopt historical manual imports; preview before importing projects that were previously migrated by scripts.

## Changes owned by this fork

- `lib/codex-projects/`: source adapter, migration orchestration and dedicated entry points.
- `lib/host-invariants.mjs` and host boundary hooks: native checkpoint prices.
- Generic explicit tool-call advertisement normalization.
- Dedicated Codex project UI tab, synthetic tests, and maintenance documentation.

Real chat exports, credentials, user databases and local migration backups do not belong in this repository. All committed fixtures must be synthetic.

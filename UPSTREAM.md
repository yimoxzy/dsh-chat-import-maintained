# Upstream and maintained fork

This is **dsh-chat-import-maintained**, an independently maintained fork of [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import), released under the original MIT license. Preserve LICENSE and the original copyright notices when redistributing.

- Upstream baseline: `c6097b3` (`0.26.5`).
- Current maintained release: `0.28.0-maintained.1`.
- Maintained source: [yimoxzy/dsh-chat-import-maintained](https://github.com/yimoxzy/dsh-chat-import-maintained).
- Local maintenance branch: `maintained/codex-projects`; public source is on `main`.
- Original remote: `upstream`. The maintained package has not been published to npm.

## Maintained release history

- `0.27.0-maintained.1` introduced the Codex SQLite/JSONL project adapter, complete history, native checkpoint pricing and isolated project ledger.
- `0.27.0-maintained.2` corrected the bundle patch to resolve the maintained package instead of an installed upstream module.
- `0.28.0-maintained.1` unifies modern Codex handling in the normal Import tab when Codex is selected. It adds read-only action classification, verified legacy adoption and guarded native append-only source updates. The duplicate project tab is removed.

## Intent and boundaries

Keep upstream's existing format adapters. The selected Codex source reads desktop SQLite history plus JSONL fallback, retains original names and complete history and verifies native projections, project membership and sidebar notifications. The tool and UI share the migration plan. Direct file/JSONL imports and all-source discovery retain their upstream generic paths.

A separate project ledger can adopt recognized legacy imports only after exact source identity, cwd/workspace evidence and complete content-prefix verification. Identical verified adoption records the ledger without appending messages. Source growth appends only when previous source turns are a proven prefix, target conversation atoms remain unchanged and a guarded native writer is available: an exclusive lease for a cold target or validated synchronous appends on the current idle live Session. Conflicts create a full copy on explicit import; ambiguous matches are refused even with force. No source database writes, automatic wiping or historical-message rewrites occur.

The upstream and maintained packages expose overlapping tools, routes and UI. **Enable only one at a time.** Existing upstream records remain intact. A similar title or folder name is not sufficient to adopt an old conversation; inspect the plan's classification and evidence first.

## Changes owned by this fork

- `lib/codex-projects/`: read-only adapter, plan/adoption/update contracts, migration ledger and shared entry points.
- `lib/host-invariants.mjs` and host boundary hooks: native checkpoint prices.
- Generic explicit tool-call advertisement normalization.
- Unified selected-Codex UI, synthetic tests and maintenance documentation.

Real chat exports, credentials, user databases and local migration backups do not belong in this repository. All committed fixtures must be synthetic. See the [maintenance guide](docs/MAINTAINING.zh-CN.md) and [migration contract](docs/CODEx-PROJECTS.md).

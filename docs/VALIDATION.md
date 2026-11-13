# Maintained release validation

Current release under validation: `dsh-chat-import-maintained@0.28.0-maintained.1`.

The unified release has passed a running DSH 0.2.2-rc.1 synthetic integration: read-only preview, complete initial import, unchanged skip, same-target append-only source update, two-sided continuation conflict copy, and no-duplicate adoption into an empty ledger. Long 20,000-character prompts, 60,000-character tool results and exact 100-byte titles survived; native checkpoint prices, projections and actual lists were verified. Both synthetic sessions were archived and the temporary helper removed. No real conversations were updated by this test.

A read-only check of local project history classified 157 source records as 153 verified adoptable, one safe source update, one ambiguous history, one new conversation and one missing body, with no verification failures. These counts describe that local snapshot rather than a universal fixture. Current automated result: **1,851 tests passed, zero failures and zero skips** on Node.js 24.18.0/Windows. ESLint, cross-platform paths and all source test anchors passed. The developer peer-link initializer was additionally planned against the installed DSH runtime without changing links.

## Current release validation scope

The unified Import-tab Codex source and tool share read-only planning and explicit execution. Synthetic coverage should verify:

- No duplicate project tab; selecting Codex uses modern project discovery while direct file/JSONL and all-source paths preserve generic upstream handling.
- Seven classifications: `new`, `unchanged`, `adoptable`, `update`, `conflict`, `ambiguous`, `missing`.
- Scan/planning does not write a ledger, append messages or create DSH sessions.
- A unique legacy mapping requires exact source identity, cwd/workspace evidence and complete prior-source content prefix; matching titles alone are insufficient. Archived duplicates are excluded, multiple active matches are refused and force cannot bypass ambiguity.
- Clicking import adopts an identical verified legacy target without adding conversation messages and records any existing DSH continuation.
- Append-only source growth updates the same verified target only when previous source-turn hashes are a prefix and target atoms remain unchanged. Cold-writer lease rechecks and live-Session identity/hash/idle checks reject concurrent changes; prior events remain intact.
- Metadata-only updates append title metadata through the same guarded writer path. DSH continuation, edited historical source turns and unverifiable legacy append boundaries produce a conflict copy only on explicit import.
- Missing source directories require a remap unless exact adoption evidence proves a unique retained workspace; the plugin creates no empty replacement project directory.
- Full long texts and tool results, native lifecycle declarations, checkpoint token pricing, exact names, project membership, native projection and actual session-list/notification results remain valid.

All source fixtures must be synthetic. Native formatter/estimator integration tests require matching installed peers. Server list and notification verification does not by itself prove a browser has received or rendered its DOM update.

## Historical baseline: 0.27.0-maintained.1

The earlier independent project-entry release completed 1,811 Node.js tests with no failures or skips on Node.js 24.18.0, Windows. ESLint, path policy, documentation links, source test anchors, sensitive-content scan and package build checks passed for that release. Its test-only DSH `0.2.2-rc.1` integration checked:

1. Read-only preview created no native session or ledger.
2. A 20,000-character prompt, 60,000-character tool result and 100-byte original title survived import.
3. Native tool lifecycles, exact checkpoint pricing and nonnegative token projections were valid.
4. The real session-list API returned the target and title and received its list notification.
5. Unchanged sources skipped; source growth used a distinct copy under that older release's policy and preserved the first record.
6. Source snapshots were unchanged by importing; the two synthetic sessions were archived and the temporary helper was removed.

These historical checks do not validate the new in-place append policy. The old copy-on-every-change behavior has been superseded.

A historical read-only local metadata check found 36 projects and 156 associated entries, 155 with bodies and one without. Later source changes can alter these counts. No real conversation bodies or credentials were included in committed fixtures.

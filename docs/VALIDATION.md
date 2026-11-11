# Maintained release validation

Release: `dsh-chat-import-maintained@0.27.0-maintained.1`.

## Automated checks

- Full Node.js test suite: **1811 passed, 0 failed, 0 skipped** on Node.js 24.18.0, Windows.
- ESLint, cross-platform path policy, relative documentation links, source test anchors, sensitive-content scan and package build checks pass.
- New source fixtures are synthetic SQLite databases and JSONL. No real chat bodies or credentials are committed.
- Native invariant tests additionally use the installed matching DSH session formatter and estimator when peers are available.

## Running DSH integration

A temporary test-only bundle called this checkout's migration pipeline inside DSH `0.2.2-rc.1`. It generated an isolated synthetic Codex home and ledger, using an existing workspace without changing its name. It verified:

1. Preview creates no DSH sessions or ledger and leaves source data unchanged.
2. A 20,000-character prompt, 60,000-character tool output and 100-byte title survive import exactly.
3. Tool lifecycles are valid, checkpoint prices match the running native estimator, and native projections have nonnegative token counts.
4. The actual native session list returns the session and exact title; the migration sends its list update notification.
5. An unchanged import skips the existing target.
6. A synthetic source update creates a distinct new target and preserves the old target's complete record and ledger mapping.
7. Source snapshots remain unchanged by importing. The two test sessions were archived using the native service, and the temporary helper was removed.

The integration report is a local development artifact outside this repository. This document records checks performed, not a claim that every DSH version, every database schema, or every browser theme has been tested. The server list/notification check does not observe a browser DOM acknowledgement.

## Read-only real metadata check

The local scanner found 36 projects and 156 project-associated entries: 155 with readable bodies and one without a body, matching the previously audited migration metadata. Only counts were recorded; no real data was imported by this check or included in test fixtures.

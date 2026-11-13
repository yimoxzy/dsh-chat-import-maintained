# Unified Codex import and safe updates

Use the normal **Import** tab and select **Codex**. There is no second project-import tab. The selected Codex source uses the modern project scanner and migration planner; direct JSONL/file imports and all-source discovery retain the upstream generic paths. The `codex_project_migrate` tool shares the project migration pipeline and defaults to `preview:true`.

## Read-only plan

The scanner accepts a Codex home directory (`CODEX_HOME` or `~/.codex` by default). SQLite is opened read-only using the highest numeric `state_*.sqlite` and `thread_history_*.sqlite` generation. Native project metadata, desktop assignments and sidebar order, title indexes and rollout files are merged by source session ID. Exact-root inference is marked and can be disabled. Projectless, guardian and subagent threads are excluded.

Metadata discovery does not read conversation bodies. Planning reads selected source and target bodies to prove identity and content, but creates no DSH sessions, appends no messages and writes no migration ledger. The resulting action is explicit:

| Action | Meaning on an explicit import |
|---|---|
| `new` | No recognized existing-import evidence; create a complete imported session. |
| `unchanged` | The recorded source fingerprint is unchanged; verify the existing target and skip. |
| `adoptable` | Exactly one active legacy target is verified; record it in the project ledger without appending conversation messages. Existing DSH continuation is retained and marked in the baseline. |
| `update` | Source turns form an append-only extension and target content still matches its baseline; append only the verified suffix through the guarded native writer. A metadata-only change appends title metadata. |
| `conflict` | DSH has continued/edited, source history was rewritten, or legacy evidence cannot prove turn-level append boundaries; create a complete new copy only when import is clicked. |
| `ambiguous` | Multiple active candidates or insufficient identity/content proof; refuse to import, including with force. |
| `missing` | Source body is unavailable; report the entry and do not create an empty session. |

Force requests a new copy for otherwise verified classifications; it does not bypass ambiguity or fabricate missing bodies. Scan classification is a preview: execution re-reads evidence, and update writes re-check the entire target through either an exclusive cold persistence handle or the verified live Session that already owns its writer.

## Verified legacy adoption

Candidate recognition uses exact source IDs from the stock import registry, recognized historical imported IDs, source-document metadata or an optional `adoptionManifest`. A manifest is an evidence hint, not permission to trust a matching name. Candidates must agree with the recorded working directory or verified workspace membership, and their complete prior source content must be an ordered prefix of the actual target conversation. Names alone are never session identity. Archived duplicate targets are excluded; multiple active matches are refused.

When the complete source is unchanged, clicking import may adopt a unique verified target by writing its ledger baseline only. If a verified historical source document is a complete prefix of the current source and the prefix ends at an exact current turn boundary, with no DSH continuation, the planner can append the verified suffix. Other source changes do not prove safe turn boundaries; they remain conflicts and create reviewed copies instead of guessing an append point. An unreadable or unavailable source document cannot silently establish an adoption baseline.

A moved/deleted original project directory is not recreated. A unique retained workspace may be reused only when verified adoption evidence proves its membership and actual header path. Otherwise supply `cwdRemap` to an existing destination. Missing destinations are reported; mapping a path never supplies missing project code.

## Append-only updates

The ledger is keyed by Codex home and source session ID and records source-turn hashes and target conversation atoms. A changed source qualifies for in-place update only when its previous source turns are an exact prefix of the new source turns, the actual target atoms equal the saved target baseline and the target is not marked continued. Historical edits, changed turns and DSH continuation produce conflict rather than splicing unrelated histories.

The update path refuses a running target. A cold target requires a native exclusive write handle: after acquiring it, all target events are re-read and compared with the planned record before appending. An already live target uses the Session that owns its writer: a detached native Session first validates the proposed complete log, then identity, whole-log hash and idle state are checked again immediately before synchronous public appends, with no asynchronous gap for another task to interleave. Both paths preserve prior events, reject reused tool-call IDs and append a bounded native checkpoint priced with the running host estimator. Metadata updates use the same guarded writer path. An unavailable lease, changed target or unsupported native API fails without automatic deletion or replacement.

## Complete storage and verification

The modern path keeps source titles without origin prefixes or suffixes and retains complete source turns before an explicit nonsemantic archive notice/checkpoint. That notice is not an AI summary. Native tool calls advertise matching assistant blocks, and checkpoint prices use the running host token meter. Missing source image bytes or text cannot be invented; limitations are counted and reported.

After a successful operation the pipeline verifies native readability, exact title, project membership and optional native projections, calls the real session-list API and publishes summaries through `api-session/added`. Missing optional services or failed list verification remain explicit; a server notification is not a browser DOM acknowledgement.

No Codex source writes, automatic periodic synchronization, DSH engine patches, history wiping or historical-message rewrites are performed. The maintained and upstream packages still expose overlapping generic tools and routes, so enable only one package at a time.

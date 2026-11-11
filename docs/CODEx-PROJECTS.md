# Codex project migration contract

`codex_project_migrate` and the Codex Projects tab use the same pipeline. A missing `preview` field means read-only preview. Scan does not read message bodies; migration preview reads selected bodies to validate convertibility but never writes DSH sessions or the ledger.

The scanner accepts a Codex home directory (`CODEX_HOME` or `~/.codex` by default). SQLite is opened read-only using the highest numeric `state_*.sqlite` and `thread_history_*.sqlite` generation. It merges native project metadata, desktop project assignments and sidebar order, title indexes and rollout files. Exact-root inference is explicitly marked and can be disabled. Projectless, guardian and subagent threads are excluded. Missing source bodies are reported instead of creating empty sessions.

The project entry preserves source titles without origin prefixes or suffixes. All stored source turns are retained before an explicit nonsemantic archive notice/checkpoint. Tools must advertise their calls in assistant content; checkpoint prices are recalculated by the running host token meter before native persistence. Missing native APIs fail before checkpoint writes.

A separate ledger keys sources by Codex home and source session id. Unchanged source content returns the existing verified target. Changed source content and force create fresh immutable copies; previous imports and user replies are never rewritten. This first maintained release intentionally uses copy-on-change rather than attempting to splice a changed source into a continued conversation.

After import the pipeline reads the native log, checks the exact title and source conversation digest, verifies workspace membership, warms the native projection when available, calls the real session list API and publishes its summaries through `api-session/added`. Missing optional projection/list services are reported as unverified, never claimed as visual confirmation. A connected browser acknowledgement is outside the server API contract.

## Maintenance boundaries

No source database writes, no automatic periodic synchronization, no DSH engine patches and no credential access. Original stock import routes remain available for other formats. Since the maintained package retains those routes and tools, only one of the upstream or maintained package may be enabled at a time.

The maintained project ledger is separate from previous manual repair scripts and stock `imports.json`. It does not automatically adopt their existing sessions. Preview first when a project has already been migrated by another mechanism.

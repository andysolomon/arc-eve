# Eve session-run monitoring (option 1)

Issue #7 chooses **option 1: retain ARC Pi's `session-runs` monitor contract**.
Eve's synchronous, always-approved `arc_delegate` writes schema-version 1 records
under `${ARC_PI_HOME:-$HOME/.arc-pi}/session-runs/<session-id>/<run-id>.json`.
The session id must be a safe `ctx.session.id`; calls without one skip the
best-effort registry write (there is no shared fallback bucket).

Records contain the required reader fields (`route`, `backend`, and nullable
`model` included), are written with a temporary file and rename, and use mode
0600. Updates are serialized per run and merge the on-disk record. Once a run
is terminal, late heartbeats and duplicate end updates cannot rewrite it.
The contract has no `blocked` status, so a runner that exits 0 but returns a
`blocked` or malformed worker result is recorded as `failed` with `exitCode: 0`;
monitors never show a blocked worker as `completed`.

`liveActivity` is a bounded v1 snapshot: phase history is capped at 6,
activities at 5, files at 20, and accepted events at 200. Only the structured
v1 events accepted by `parseEvent` are mapped; paths remain repository-relative
and sensitive paths/content are rejected or filtered. v2 diffs are currently
not admitted. Stderr, task contracts, and arbitrary event text are never
stored.

This preserves the existing synchronous runner, routing, host-cwd handling, and
`always()` approval. `background: true` remains rejected: Eve 0.54.3's current
path has no background `jobId`. The schema retains optional `jobId` for future
background-compatible calls, and foreground runs never invent one. Registry
failure is best effort and only adds bounded risk evidence to the result.

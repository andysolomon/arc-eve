# Eve v1 operator surface

## Decision

Use `eve dev` as the primary v1 operator surface. It is the interactive HITL
surface available in this app and can render Eve approvals and streams. ARC Pi
remains the daily harness until the real provider-backed runner test is done.

ACP and HTTP remain deferred surfaces, not equivalent parents for a host
checkout:

- **ACP:** currently has no host checkout mount or arbitrary host filesystem
  access, and session resume is not guaranteed.
- **HTTP:** requires an explicit authenticated operator-only adapter before it
  is a supported operator surface.

The v1 host-checkout decision still applies: the narrowly scoped
`arc_delegate` host child-process path may invoke the existing runner; Eve does
not gain general host filesystem access.

## ARC Pi command mapping

- Eve 0.54.3 has no supported operator-only authored-tool visibility boundary,
  so `/arc-login` and `/arc-auth-status` are not registered model tools.
  Operators can use the host-only `pnpm provider-auth -- status
  cursor-agent|claude-code` or `pnpm provider-auth -- login
  cursor-agent|claude-code`. Binary identity comes from the canonical ARC Pi
  variables `ARC_ORCHESTRATOR_CURSOR_BIN` and
  `ARC_ORCHESTRATOR_CLAUDE_BIN`; `CURSOR_AGENT_BIN` and `CLAUDE_CODE_BIN` are
  compatibility aliases only, and canonical values take precedence. The
  command prints generic redacted state. This is not an Eve model surface and
  does not replace vendor-owned authentication.
- `arc_delegate` is the always-gated, synchronous Eve tool and continues to
  use the existing runner. The foreground path has no invented `jobId`.
- `/arc-monitor` and `/arc-monitor-tui` are preserved through `session-runs`
  when available. Otherwise, defer them until [issue #7](https://github.com/andysolomon/arc-eve/issues/7).
- Analyze, `ask-question`, artifact operations, `git`, and `gh` remain
  parent/operator host actions; they do not become new model-callable Eve
  equivalents.
- Deploy remains a separate synchronous, always-gated `arc_delegate` path.

Eve is the parent/HITL layer only. It does not replace
`arc-orchestrator` or `runner-routing-v4`, nor does it replace their worker
routing, locking, sandboxing, or authentication responsibilities. Monitoring
remains the `session-runs` option-1 contract. See the [runner spike evidence](runner-spike.md).

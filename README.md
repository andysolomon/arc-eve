# ARC Eve

ARC Eve is an experimental **Eve parent** for ARC Delegate. It keeps
[`andysolomon/arc-orchestrator`](https://github.com/andysolomon/arc-orchestrator)
as the worker plane and asks whether [eve](https://eve.dev/docs/getting-started)
can replace [ARC Pi](https://github.com/andysolomon/arc-pi) as the interactive
parent.

This is a spike, not a daily harness. Keep using ARC Pi until a real
provider-backed external runner test proves that Eve can sit in a host checkout
without giving up runner-routing-v4, vendor-owned CLI auth, or fail-closed
authorization.

As decided in issue #6, `arc-orchestrator` and `runner-routing-v4` remain the
worker plane; Eve is the parent, not a replacement for those workers.

## Why this exists

ARC Pi’s product is a **local coding-agent parent** plus an **external
multi-CLI runner**. Pi currently affords:

- a TUI that runs in the operator’s git checkout
- parent-local Analyze, then bounded Explore → Research → Plan → Implement →
  Verify → Deploy
- Cursor Agent, Claude Code, Codex, OpenCode, and Composer as **workers**, not
  parent models
- fail-closed operator gates and vendor-owned Provider CLI login

Eve is a filesystem-first durable agent framework (`agent/` on disk, Workflow
sessions, isolated `/workspace`, `eve dev` TUI, ACP, HTTP/Slack). That is a
better HITL and channel runtime than Pi. It is a worse default for “open a pane
in this repo.”

**Viable shape:** Eve parent → the same `arc_delegate` contract → existing
runner.

**Not viable as v1:** replacing the runner with Eve subagents, or treating Eve
as a drop-in for `bin/arc-pi`.

## Keep vs rewrite

| Keep | Rewrite on Eve |
| --- | --- |
| External `arc-orchestrator` and `runner-routing-v4` | Parent loop, instructions, tools |
| Bounded contract, phases, workload classes | Explore/Plan/Implement/Deploy gates as Eve `approval` |
| Vendor-owned Cursor / Claude Code login | Operator-only login/status tools (not model-owned) |
| Policy source in the runner / ARC Pi docs | `agent/instructions.md` + `agent/tools/arc_delegate.ts` |

Do not reimplement routing, write locking, CLI sandboxes, or the 84 explicit
route aliases inside Eve. Authored Eve tools run in the app runtime and can
spawn the existing wrapper.

## v1 workspace decision

`arc_delegate` uses the real, supplied host checkout as its worker cwd. Eve’s
isolated `/workspace` is not substituted for that checkout. Parent-local
Analyze, artifact writes, and parent-performed `git`/`gh` actions remain
host-side and operator-controlled; those facts are not model authorization.
The delegated runner work remains under `arc-orchestrator`’s own locks,
sandbox, and authentication. Eve does not thereby safely gain arbitrary host
filesystem access: the only approved host path is the narrowly scoped
`arc_delegate` host child-process path.

See the [workspace architecture note](docs/architecture/workspace.md) for the
v1 non-goals and rationale. Session-run monitoring is retained via [the
monitoring architecture note](docs/architecture/monitoring.md) (issue #7,
**option 1**).

## v1 operator surface

The primary v1 operator surface is the `eve dev` TUI. It is the interactive
Eve HITL surface for approvals and streams; ARC Pi remains the daily harness
until the real provider-backed runner test is completed. ACP and HTTP remain
deferred: ACP has no host-checkout mount or arbitrary host filesystem access
and does not guarantee session resume; HTTP needs an explicitly authenticated
operator adapter.

Eve 0.54.3 has no supported operator-only authored-tool visibility boundary.
Therefore `/arc-login` and `/arc-auth-status` are not registered model tools.
Operators may instead use the host-only command
`pnpm provider-auth -- status cursor-agent|claude-code` or
`pnpm provider-auth -- login cursor-agent|claude-code`. Binary identity comes
from the canonical ARC Pi variables `ARC_ORCHESTRATOR_CURSOR_BIN` and
`ARC_ORCHESTRATOR_CLAUDE_BIN`; `CURSOR_AGENT_BIN` and `CLAUDE_CODE_BIN` are
compatibility aliases only, and canonical values take precedence. The command
prints generic, redacted state. This is not an Eve model surface and does not
replace vendor-owned authentication.

The ARC Pi surface maps to Eve as follows:

| ARC Pi surface | Eve v1 decision |
| --- | --- |
| `/arc-login`, `/arc-auth-status` | Host-only `provider-auth`; not model tools. |
| `arc_delegate` | An always-gated, synchronous Eve tool; it remains the path to the existing runner. |
| `/arc-monitor`, `/arc-monitor-tui` | Preserved through the ARC Pi-compatible `session-runs` contract (issue #7, **option 1**). |
| Analyze, `ask-question`, artifacts, `git`, `gh` | Parent/operator host actions, not new model-callable equivalents. |
| Deploy | A separate, synchronous, always-gated `arc_delegate` path. |

The foreground Eve path is synchronous and has no invented `jobId`; monitoring
continues through `session-runs`. Eve does not replace `arc-orchestrator` or
`runner-routing-v4`; it remains the parent/HITL layer around that worker plane.
See the [runner spike evidence](docs/architecture/runner-spike.md).

## Hard questions

1. **Platform.** Eve is beta and requires Node.js 24+. ARC Pi is on 22.19+.

See [eve getting started](https://eve.dev/docs/getting-started),
[sandbox](https://eve.dev/docs/sandbox),
[human-in-the-loop](https://eve.dev/docs/human-in-the-loop), and
[ACP](https://eve.dev/docs/protocols/acp).

## Status

Pre-scaffold. Open issues track the host-cwd spike and the design decisions
that must land before any parent rewrite:

1. [Spike: invoke the runner from Eve on a real checkout](https://github.com/andysolomon/arc-eve/issues/1)
2. [Decide parent workspace: host checkout vs Eve sandbox](https://github.com/andysolomon/arc-eve/issues/2)
3. [Port ARC authorization gates to Eve approvals](https://github.com/andysolomon/arc-eve/issues/3)
4. [Operator-only Provider CLI login and status](https://github.com/andysolomon/arc-eve/issues/4)
5. [Choose the operator surface](https://github.com/andysolomon/arc-eve/issues/5)
6. [Keep runner-routing-v4; do not replace workers with Eve subagents](https://github.com/andysolomon/arc-eve/issues/6)
7. [Preserve session-runs or replace the monitor event source](https://github.com/andysolomon/arc-eve/issues/7)

```text
operator
   |
   v
eve parent (this repo, not yet built)
   |-- agent/instructions.md
   |-- agent/tools/arc_delegate.ts
   |-- approval / ask_question gates
   v
arc-orchestrator (unchanged)
   |-- runner-routing-v4
   |-- Provider CLI workers
   `-- sandbox, locking, traces
```

## Related

- [ARC Pi](https://github.com/andysolomon/arc-pi) — current local parent
- [ARC orchestrator](https://github.com/andysolomon/arc-orchestrator) — worker runner
- [eve](https://eve.dev/docs) — candidate parent framework

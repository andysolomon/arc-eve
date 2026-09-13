# ARC Eve

ARC Eve is an experimental **Eve parent** for ARC Delegate. It keeps
[`andysolomon/arc-orchestrator`](https://github.com/andysolomon/arc-orchestrator)
as the worker plane and asks whether [eve](https://eve.dev/docs/getting-started)
can replace [ARC Pi](https://github.com/andysolomon/arc-pi) as the interactive
parent.

This is a spike, not a daily harness. Keep using ARC Pi until a host-cwd
`arc_delegate` path proves that Eve can sit in a real checkout without giving
up runner-routing-v4, vendor-owned CLI auth, or fail-closed authorization.

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

## Hard questions

1. **Workspace.** Eve’s default bash is an isolated sandbox. Parent-local
   Analyze on the real repo needs a custom sandbox backend, a host bind-mount,
   or host-side tools. That decision is the spike.
2. **Operator surface.** `eve dev` TUI, ACP (no host filesystem today), or
   HTTP. ACP cannot resume sessions or mount the editor tree.
3. **Platform.** Eve is beta and requires Node.js 24+. ARC Pi is on 22.19+.

See [eve getting started](https://eve.dev/docs/getting-started),
[sandbox](https://eve.dev/docs/sandbox),
[human-in-the-loop](https://eve.dev/docs/human-in-the-loop), and
[ACP](https://eve.dev/docs/protocols/acp).

## Status

Pre-scaffold. Open GitHub issues track the host-cwd spike and the design
decisions that must land before any parent rewrite.

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

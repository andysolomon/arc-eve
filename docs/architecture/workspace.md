# Eve v1 workspace boundary

## Decision

For v1, `arc_delegate` runs with the real supplied host checkout as its
worker cwd. Eve’s isolated `/workspace` is not substituted for that checkout.
This is a narrow, approved host child-process path—not general Eve access to
the host filesystem.

Parent-local Analyze, artifact writes, and parent-performed `git`/`gh` actions
stay host-side and operator-controlled. They are not model authorization.
Delegated work stays under `arc-orchestrator`’s locks, sandbox, and
authentication; `arc-orchestrator` and `runner-routing-v4` remain the worker
plane.

## Explicit v1 non-goals

- **Custom `SandboxBackend` or a bind mount exposing the host checkout.** This
  would broaden filesystem exposure and weaken the intended security and
  isolation boundary.
- **Cloning or synchronizing the checkout into Eve `/workspace`.** A second
  checkout creates duplicate state and drift, while introducing additional
  credential and synchronization handling.

The host-cwd bridge is deliberately limited to the supplied checkout and the
approved `arc_delegate` child process. It does not make arbitrary host-side
commands or files available to Eve or to a model.

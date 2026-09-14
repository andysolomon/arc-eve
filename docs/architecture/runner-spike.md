# Host-cwd runner spike

## Evidence

The issue #1 spike invoked a disposable fake runner from the host checkout
through `ARC_ORCHESTRATOR_BIN`. The child received shell-free argv and returned
compact structured evidence. Session-runs were written safely.

No custom sandbox, bind mount, or clone/sync workaround was used. A real
provider-backed external runner was not invoked in this environment, so ARC Pi
remains the daily harness until that provider test is performed.

The result does not change the worker boundary: `arc-orchestrator` and
`runner-routing-v4` remain the worker plane. The foreground Eve path is
synchronous and has no invented `jobId`; session-runs monitoring remains the
option-1 contract.

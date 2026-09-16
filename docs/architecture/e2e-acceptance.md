# E2E acceptance (manual, opt-in)

This note defines the repeatable manual acceptance run that proves the real
provider-backed path: **Eve parent authentication → an approved, read-capable
`arc_delegate` Explore → `arc-orchestrator` → one authenticated worker CLI**,
captured as bounded, redacted pass/fail evidence.

It is a gate for the Eve spike, not a replacement workflow. **ARC Pi remains the
default daily harness.** Nothing here changes `arc-orchestrator`,
`runner-routing-v4`, vendor-owned worker authentication, or the `arc_delegate`
contract.

## CI exclusion

- The real run is **manual-only**. It never runs in `pnpm test`, `pnpm
  test:e2e:fake`, or CI.
- `scripts/e2e-acceptance.ts` refuses `--mode=real` (exit 3) whenever it detects
  an automated context: `CI`, `GITHUB_ACTIONS`, `NODE_TEST_CONTEXT`, or an
  `npm_lifecycle_event` of `test`/`test:*`. `ARC_E2E_FORCE` and every other
  `ARC_E2E_*` variable are **not** overrides; they are stripped before any
  runner environment is built and never recorded in evidence.
- Automated coverage (`test/e2e-acceptance.test.ts`) uses fake mode only: no
  vendor CLI is spawned, no login runs, no browser opens, and no network is used.

## Operator prerequisites

1. `pnpm install` on Node.js 24+.
2. Parent-provider auth: a parent credential that Eve's selected model accepts.
   `pnpm parent-provider -- check` must report `"credential":"configured"`. See
   [parent-provider.md](parent-provider.md).
3. One authenticated worker CLI: `pnpm provider-auth -- status cursor-agent` (or
   `claude-code`) reports `"status":"authenticated"`. Log in with the vendor's
   own flow beforehand if needed; the harness never runs `login`.
4. A runnable `arc-orchestrator` (`ARC_ORCHESTRATOR_BIN` or normal discovery).

## Environment conventions

| Variable | Purpose |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Gateway credential consumed by Eve string models (alias of `EVE_PARENT_API_KEY`). Presence only is recorded. |
| `EVE_PARENT_API_KEY`, `EVE_PARENT_PROVIDER`, `EVE_PARENT_MODEL` | Canonical parent settings. |
| `ARC_ORCHESTRATOR_CURSOR_BIN` | Canonical Cursor Agent worker binary (compat: `CURSOR_AGENT_BIN`; default `cursor-agent` on `PATH`). |
| `ARC_ORCHESTRATOR_CLAUDE_BIN` | Canonical Claude Code worker binary (compat: `CLAUDE_CODE_BIN`; default `claude` on `PATH`). |
| `ARC_PI_HOME` | Registry root; default `~/.arc-pi`. |

Put parent values in a file outside the repo and pass it with
`--env-from-file=<path>`; the harness parses it with the `.env.local` subset
parser and never echoes values.

## Command surface

```sh
pnpm e2e-acceptance --check                       # fake (default), offline
pnpm e2e-acceptance --run --mode=fake             # fake end-to-end, offline (synthetic parent credential unless --env-from-file)
pnpm e2e-acceptance --check --mode=real --confirm-real --env-from-file=<file>
pnpm e2e-acceptance --run   --mode=real --confirm-real --env-from-file=<file>
pnpm e2e-acceptance --run   --mode=real --confirm-real --env-from-file=<file> --checkout=<dir>
```

Optional: `--out=<dir>` (evidence directory), `--session=<id>` (session-runs
bucket, default `eve-session`). The harness is not an Eve tool and is never
registered as a model-callable tool.

**Fake mode** creates a throwaway checkout with `mkdtemp` + copy (no git clone;
`node_modules`, `.git`, `.output`, `.eve`, and `.env*` are excluded), a scoped
`ARC_PI_HOME`, an inert `cursor-agent` stub on a scoped `PATH` (never spawned),
and a fake runner. It invokes the real `arc_delegate` tool for a read-only
Explore, captures `<ARC_PI_HOME>/session-runs/eve-session/*.json`, and projects
it to allow-listed evidence.

**Real mode** uses read-only `providerStatus` probes (never `login`, never a
browser launch) and reads — never writes — `~/.arc-pi/session-runs/<session>/`.

## Runbook (real)

1. `pnpm e2e-acceptance --check --mode=real --confirm-real --env-from-file=<file>`
   must exit 0 (`ready: true`).
2. `pnpm e2e-acceptance --run --mode=real --confirm-real --env-from-file=<file>`
   copies the repo into a throwaway checkout and prints `checkout` (operator-local,
   not written to evidence) with verdict `pending-operator`.
3. Start `eve dev` from this repo with the same parent environment. Ask the
   parent for an `arc_delegate` **Explore** with `cwd` set to the printed
   checkout, and approve it in Eve's approval prompt. Any browser login during
   this step is operator-initiated through the vendor's own flow.
4. When the delegation returns, run step 2 again with `--checkout=<dir>`. The
   harness captures the newest matching `eve-session` record and writes
   `e2e-acceptance-evidence.json` plus `captured-session-run.json`.
5. Delete the throwaway checkout when done. Do not commit evidence.

## Redaction list

Evidence and stdout/stderr must never contain:

- the API key or any parent credential value;
- login URLs or device codes;
- account identifiers or email addresses;
- raw provider/vendor output;
- the prompt or task contract;
- transcripts (`user:`/`assistant:` lines);
- raw `session-runs` entries (cwd, label text, model, live activity strings).

Evidence is built only from allow-listed enums, booleans, counts, alias names,
and ISO timestamps, then scanned for key/URL/email/transcript patterns and
credential-named env values before writing. A scan hit fails closed with a
generic error and no file.

## Pass/fail criteria

`verdict: "pass"` requires every check to be true:

| Check | Meaning |
| --- | --- |
| `parentCredentialConfigured` | Parent credential present (presence only). |
| `authenticatedWorkerPresent` | At least one worker binary resolves and reports `authenticated`. |
| `approvalGated` | `arc_delegate` approval policy is `user-approval`. |
| `sessionRunCaptured` | A matching session-runs record was found. |
| `exploreCompleted` | Record phase `explore`, status `completed`. |
| `runnerExitZero` | Runner exit code `0`. |
| `runnerEnvWithoutHarnessVariables` | No `ARC_E2E_*` in the runner environment (fake mode measures it). |
| `delegateCompleted` | Fake mode only: the tool result status is `completed`. |

Anything else is `fail`. The operator additionally confirms manually that the
Eve approval prompt appeared before the runner started and that the worker used
was the one reported by `pnpm provider-auth -- status`; record both as pass/fail
next to the evidence file.

## Relationship to ARC Pi

ARC Pi stays the daily harness. This run only answers whether Eve can drive the
same runner and worker plane end to end; passing it does not switch defaults,
and failing it does not affect ARC Pi.

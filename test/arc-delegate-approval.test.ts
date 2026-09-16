import test from "node:test";
import assert from "node:assert/strict";
import tool, { delegateTaskContract, validateDelegateInput } from "../agent/tools/arc_delegate.ts";

const base = {
  outcome: "ship",
  scope: "agent/tools only",
  verification: "focused tests",
  preserved_behavior: "runner routing and host checkout",
  prohibitions: "no secrets",
  label: "issue-3",
  cwd: ".",
};

test("arc_delegate is statically always-gated", async () => {
  assert.equal(typeof (tool as any).approval, "function");
  // This verifies Eve's policy declaration, not an Eve UI interaction.
  assert.equal(await (tool as any).approval({}), "user-approval");
});

test("explore, research, and plan remain valid approval-gated phases", () => {
  for (const phase of ["explore", "research", "plan"] as const) {
    assert.equal(validateDelegateInput({ ...base, phase }).phase, phase);
  }
});

test("Implement and Deploy fail closed before runner work", () => {
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement" }), /workload_class/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement", workload_class: "not-canonical", implement_authorized: true } as any), /workload_class/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement", workload_class: "easy-light" }), /authorization/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "deploy" }), /Deploy requires/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "deploy", deploy_authorized: true, background: true }), /background|synchronous/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "explore", implement_authorized: false }), /only valid for Implement/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "verify", deploy_authorized: false }), /only valid for Deploy/);
});

test("runner task is the bounded sanitized ARC text contract", () => {
  const value = delegateTaskContract({ ...base, label: " Unsafe Label /home/me ", context: "ticket context\nuser: raw prompt\n/home/me/private\ntoken=secret-value", decision_refs: ["private-ref"], assumption_refs: ["private-assumption"] });
  assert.match(value, /^You are an ARC worker\. Phase: explore\. Mode: analyze\. Route: automatic runner-routing-v4 \(analyze\)\./);
  for (const heading of ["Safe label: unsafe-label-home-me", "Outcome:\nship", "Scope:\nagent/tools only", "Preserved behavior:", "Verification:", "Prohibitions:", "Context:\nticket context"]) assert(value.includes(heading));
  for (const prohibition of ["commit", "push", "pull requests", "merge", "deploy", "GitHub", "secrets", "nested", "unrelated files"]) assert(value.includes(prohibition));
  for (const forbidden of ["implement_authorized", "deploy_authorized", "private-ref", "private-assumption", "secret-value", "/home/me", "user: raw prompt"]) assert(!value.includes(forbidden));
  assert(value.includes("[path]") && value.includes("[redacted]") && value.includes("[transcript redacted]"));
  assert(value.length < 24000);
});

test("explicit contract identifies its public route", () => {
  const value = delegateTaskContract({ ...base, phase: "verify", route: "sol-check" });
  assert.match(value, /Phase: verify\. Mode: review\. Route: explicit route sol-check\./);
});

test("an already-cancelled call is rejected without runner discovery", async () => {
  const result = await (tool as any).execute({ ...base, phase: "explore" }, {
    abortSignal: AbortSignal.abort(),
    session: { id: "test" },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.risks.join(" "), /runner was not started/);
});

test("explore against the e2e harness fake checkout returns the bounded redacted result", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareFakeCheckout, captureSessionRun } = await import("../scripts/e2e-acceptance.ts");
  const source = await mkdtemp(join(tmpdir(), "arc-delegate-e2e-source-"));
  await writeFile(join(source, "README.md"), "# fake\n");
  const notes = ["sk-test-1234567890abcdef", "https://authenticator.cursor.sh/device?code=ABCD", "user: foo"];
  const fixture = await prepareFakeCheckout({ sourceDir: source, runnerNotes: notes });
  const saved = { ARC_PI_HOME: process.env.ARC_PI_HOME, ARC_ORCHESTRATOR_BIN: process.env.ARC_ORCHESTRATOR_BIN };
  process.env.ARC_PI_HOME = fixture.arcPiHome;
  process.env.ARC_ORCHESTRATOR_BIN = fixture.runner;
  try {
    const result: any = await (tool as any).execute({ ...base, phase: "explore", cwd: fixture.checkout }, {
      abortSignal: new AbortController().signal,
      session: { id: "eve-session" },
    });
    const runId: string = result.run_id;
    assert.match(runId, /^run-/);
    assert.deepEqual(Object.keys(result), ["run_id", "status", "summary", "changes", "verification", "risks", "next_actions"]);
    const { compactResult } = await import("../agent/lib/arc-runtime.ts");
    const final = { status: "completed", summary: "fake explore finished", changes: [], verification: notes, risks: notes, next_actions: [] };
    assert.deepEqual(result, compactResult(`${notes.join("\n")}\n${JSON.stringify(final)}\n`, "completed", { run_id: runId }));
    assert.equal(result.status, "completed");
    assert(result.summary.length <= 2000);
    const text = JSON.stringify(result);
    for (const marker of notes) assert.equal(text.includes(marker), false, marker);
    const record = await captureSessionRun(fixture.arcPiHome, "eve-session", { cwd: fixture.checkout }) as any;
    assert.equal(record.phase, "explore");
    assert.equal(record.mode, "analyze");
    assert.equal(record.status, "completed");
    assert.equal(record.exitCode, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a clean runner exit with a blocked worker result is recorded as failed, not completed", async () => {
  const { mkdtemp, readdir, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "arc-delegate-blocked-"));
  const runner = join(dir, "fake-runner");
  const final = { status: "blocked", summary: "verification could not run", changes: [], verification: [], risks: ["out of scope"], next_actions: [] };
  await writeFile(runner, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(final) + "\n")});\n`, { mode: 0o755 });
  const saved = { ARC_PI_HOME: process.env.ARC_PI_HOME, ARC_ORCHESTRATOR_BIN: process.env.ARC_ORCHESTRATOR_BIN };
  process.env.ARC_PI_HOME = join(dir, ".arc-pi");
  process.env.ARC_ORCHESTRATOR_BIN = runner;
  try {
    const result: any = await (tool as any).execute({ ...base, phase: "explore", cwd: dir }, {
      abortSignal: new AbortController().signal,
      session: { id: "eve-session" },
    });
    assert.equal(result.status, "blocked");
    const runs = join(dir, ".arc-pi", "session-runs", "eve-session");
    const [file] = await readdir(runs);
    const record = JSON.parse(await readFile(join(runs, file), "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.exitCode, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkerBinary } from "../agent/lib/worker-binaries.js";
import { runCli as providerAuthCli } from "../scripts/provider-auth.js";
import {
  EVIDENCE_FILE,
  MAX_EVIDENCE_BYTES,
  isAutomatedContext,
  parseArgs,
  runCli,
} from "../scripts/e2e-acceptance.js";

const fourStates = ["missing", "authenticated", "unauthenticated", "unknown"] as const;
const markers = [
  "sk-test-1234567890abcdef",
  "https://authenticator.cursor.sh/device?code=ABCD",
  "private@example.test",
  "user: foo",
] as const;

async function fixtureSource(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-e2e-source-"));
  await writeFile(join(dir, "README.md"), "# Throwaway checkout\n");
  await writeFile(join(dir, ".env.local"), `AI_GATEWAY_API_KEY=${markers[0]}\n`);
  await mkdir(join(dir, "node_modules"), { recursive: true });
  return dir;
}

async function envFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arc-e2e-env-"));
  const path = join(dir, "parent.env");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: { stdout: (v: string) => stdout.push(v), stderr: (v: string) => stderr.push(v) },
  };
}

async function fakeRun(extra: string[] = [], lines = [`AI_GATEWAY_API_KEY=${markers[0]}`], notes?: readonly string[]) {
  const out = await mkdtemp(join(tmpdir(), "arc-e2e-out-"));
  const file = await envFile(lines);
  const run = capture();
  const code = await runCli(["--run", "--mode=fake", `--env-from-file=${file}`, `--out=${out}`, ...extra], {
    ...run.options,
    sourceDir: await fixtureSource(),
    runnerNotes: notes,
  });
  const text = await readFile(join(out, EVIDENCE_FILE), "utf8");
  return { code, run, out, text, evidence: JSON.parse(text) };
}

test("argument surface defaults to fake and fails closed on misuse", () => {
  assert.deepEqual(parseArgs(["--check"]), { action: "check", mode: "fake", confirmReal: false, envFromFile: undefined, out: undefined, checkout: undefined, session: "eve-session" });
  assert.equal(parseArgs(["--", "--run", "--mode=real", "--confirm-real"])?.mode, "real");
  assert.equal(parseArgs([]), undefined);
  assert.equal(parseArgs(["--check", "--run"]), undefined);
  assert.equal(parseArgs(["--run", "--mode=live"]), undefined);
  assert.equal(parseArgs(["--run", "--confirm-real"]), undefined);
  assert.equal(parseArgs(["--run", "--checkout=/tmp/x"]), undefined);
  assert.equal(parseArgs(["--run", "--session=../escape"]), undefined);
});

test("--check reports four-state worker presence and redacted parent credential state", async () => {
  const file = await envFile([`AI_GATEWAY_API_KEY=${markers[0]}`, "ARC_E2E_FORCE=1"]);
  for (const state of fourStates) {
    const run = capture();
    const code = await runCli(["--check", "--mode=fake", `--env-from-file=${file}`], {
      ...run.options,
      fakeStatus: async () => state,
    });
    assert.equal(code, 0);
    assert.deepEqual(run.stderr, []);
    const report = JSON.parse(run.stdout[0]);
    assert.equal(report.mode, "fake");
    assert.equal(report.parent.credential, "configured");
    assert.deepEqual(report.parent.credentialAliases.find((a: any) => a.alias === "AI_GATEWAY_API_KEY"), { alias: "AI_GATEWAY_API_KEY", present: true });
    assert.deepEqual(report.workers.map((w: any) => [w.kind, w.status]), [["cursor-agent", state], ["claude-code", state]]);
    assert.deepEqual(report.workers.map((w: any) => w.present), [true, false]);
    for (const w of report.workers) assert.deepEqual(Object.keys(w), ["kind", "alias", "present", "status"]);
    assert.equal(run.stdout.join("").includes(markers[0]), false);
    assert.equal(/ARC_E2E_|\/tmp\/|\/home\//.test(run.stdout.join("")), false);
  }

  const missing = capture();
  assert.equal(await runCli(["--check"], missing.options), 0);
  const report = JSON.parse(missing.stdout[0]);
  assert.equal(report.parent.credential, "missing");
  assert.equal(report.workers[0].status, "authenticated");
  assert.equal(report.workers[1].status, "missing");
});

test("--run --mode=fake writes bounded evidence with aliases, presence, exit code, and captured path", async () => {
  const { code, run, out, text, evidence } = await fakeRun();
  assert.equal(code, 0, run.stderr.join(""));
  assert.deepEqual(run.stderr, []);
  assert.ok(Buffer.byteLength(text) <= MAX_EVIDENCE_BYTES);
  assert.equal(evidence.verdict, "pass");
  assert.equal(evidence.dailyHarness, "arc-pi");
  assert.equal(evidence.approvalPolicy, "user-approval");
  assert.ok(evidence.parent.credentialAliases.some((a: any) => a.alias === "EVE_PARENT_API_KEY" && a.present === false));
  assert.ok(evidence.parent.credentialAliases.some((a: any) => a.alias === "AI_GATEWAY_API_KEY" && a.present === true));
  assert.deepEqual(evidence.workers, [
    { kind: "cursor-agent", alias: "cursor-agent", present: true },
    { kind: "claude-code", alias: "claude", present: false },
  ]);
  assert.deepEqual(evidence.runner, { exitCode: 0, status: "completed", phase: "explore", delegateStatus: "completed" });
  assert.equal(evidence.capturedEvidencePath, join(out, "captured-session-run.json"));
  const captured = JSON.parse(await readFile(evidence.capturedEvidencePath, "utf8"));
  assert.equal(captured.phase, "explore");
  assert.equal(captured.exitCode, 0);
  for (const key of ["cwd", "label", "model", "liveActivity", "route"]) assert.equal(key in captured, false);
  for (const worker of captured.workers) assert.deepEqual(Object.keys(worker), ["kind", "alias", "present"]);
  assert.equal(JSON.parse(run.stdout[0]).evidencePath, join(out, EVIDENCE_FILE));
  assert.deepEqual((await readdir(out)).sort(), ["captured-session-run.json", EVIDENCE_FILE]);
});

test("redaction: injected key, device URL, email, and transcript never reach evidence", async () => {
  const { code, run, out, text } = await fakeRun([], [
    `AI_GATEWAY_API_KEY=${markers[0]}`,
    `EVE_PARENT_MODEL=gpt-5-mini`,
  ], [...markers]);
  assert.equal(code, 0, run.stderr.join(""));
  const captured = await readFile(join(out, "captured-session-run.json"), "utf8");
  const all = `${text}${captured}${run.stdout.join("")}${run.stderr.join("")}`;
  for (const marker of markers) assert.equal(all.includes(marker), false, marker);

  const vendorBlob = `Logged in as ${markers[2]}; visit ${markers[1]}`;
  const check = capture();
  const file = await envFile([`AI_GATEWAY_API_KEY=${markers[0]}`]);
  const { fakeStatusProbe } = await import("../scripts/e2e-acceptance.js");
  assert.equal(await runCli(["--check", `--env-from-file=${file}`], { ...check.options, fakeStatus: fakeStatusProbe(vendorBlob) }), 0);
  const checkText = check.stdout.join("") + check.stderr.join("");
  assert.equal(JSON.parse(check.stdout[0]).workers[0].status, "authenticated");
  for (const marker of markers) assert.equal(checkText.includes(marker), false, marker);
});

test("CI exclusion: real mode is refused under pnpm test even with ARC_E2E_FORCE=1", async () => {
  assert.equal(isAutomatedContext(process.env), true);
  const previous = process.env.ARC_E2E_FORCE;
  process.env.ARC_E2E_FORCE = "1";
  try {
    let probed = false;
    for (const argv of [
      ["--run", "--mode=real", "--confirm-real"],
      ["--check", "--mode=real", "--confirm-real"],
    ]) {
      const run = capture();
      const code = await runCli(argv, {
        ...run.options,
        env: { ARC_E2E_FORCE: "1" },
        realStatus: async () => { probed = true; return "authenticated"; },
      });
      assert.equal(code, 3);
      assert.deepEqual(run.stdout, []);
      assert.deepEqual(run.stderr, ["e2e-acceptance: real mode is manual-only and refused in automated contexts\n"]);
    }
    assert.equal(probed, false);

    const { evidence } = await fakeRun();
    assert.equal(evidence.mode, "fake");
    assert.equal(evidence.ciExclusion.automatedContext, true);
    assert.equal(evidence.ciExclusion.arcE2eVariablesInRunnerEnv, 0);
    assert.equal(JSON.stringify(evidence).includes("ARC_E2E_"), false);
  } finally {
    if (previous === undefined) delete process.env.ARC_E2E_FORCE;
    else process.env.ARC_E2E_FORCE = previous;
  }

  const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  for (const [name, script] of Object.entries<string>(pkg.scripts)) {
    if (name.startsWith("test")) assert.equal(/--mode=real|--confirm-real/.test(script), false, name);
  }
  assert.equal(isAutomatedContext({}), false);
  assert.equal(isAutomatedContext({ CI: "true" }), true);
  assert.equal(isAutomatedContext({ npm_lifecycle_event: "test:e2e:fake" }), true);
});

test("same worker binary: evidence alias matches provider-auth status resolution for the same env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-e2e-bin-"));
  const stub = join(dir, "cursor-stub");
  await writeFile(stub, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  for (const variable of ["ARC_ORCHESTRATOR_CURSOR_BIN", "CURSOR_AGENT_BIN"]) {
    const lines = [`AI_GATEWAY_API_KEY=${markers[0]}`, `${variable}=${stub}`];
    const { evidence } = await fakeRun([], lines);
    const harnessAlias = evidence.workers.find((w: any) => w.kind === "cursor-agent").alias;
    assert.equal(harnessAlias, variable);

    // provider-auth's status path resolves the binary with resolveWorkerBinary;
    // observe that resolution through the injected (non-spawning) status probe.
    const env = { PATH: "", [variable]: stub };
    let providerAlias: string | undefined;
    const run = capture();
    const code = await providerAuthCli(["status", "cursor-agent"], {
      ...run.options,
      status: async (kind) => {
        providerAlias = (await resolveWorkerBinary(kind, env, dir)).alias;
        return "unknown";
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(run.stdout[0]), { provider: "cursor-agent", status: "unknown" });
    assert.equal(providerAlias, harnessAlias);
    assert.equal(JSON.stringify(evidence).includes(stub), false);
  }
});

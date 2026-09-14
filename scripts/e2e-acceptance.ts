import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyProviderStatus, providerStatus, type ProviderStatus } from "../agent/lib/arc-auth.js";
import { parseDotEnvLocal, redactParentProviderText, resolveParentProvider } from "../agent/lib/parent-provider.js";
import { resolveWorkerBinary, workerBinaryDefaults, workerBinaryEnv, type WorkerKind } from "../agent/lib/worker-binaries.js";

/*
 * Host-only, opt-in manual acceptance harness. It is not an Eve tool and must
 * never be imported from agent/tools. `--mode=fake` (the default) is offline and
 * hermetic; `--mode=real` is operator-initiated, needs --confirm-real, and is
 * refused in every automated context (CI, node --test, pnpm test scripts).
 */

export type HarnessAction = "check" | "run";
export type HarnessMode = "fake" | "real";

export interface HarnessArgs {
  action: HarnessAction;
  mode: HarnessMode;
  confirmReal: boolean;
  envFromFile?: string;
  out?: string;
  checkout?: string;
  session: string;
}

export const DEFAULT_SESSION_ID = "eve-session";
export const EVIDENCE_FILE = "e2e-acceptance-evidence.json";
export const CAPTURED_FILE = "captured-session-run.json";
export const MAX_EVIDENCE_BYTES = 4096;

const kinds: readonly WorkerKind[] = ["cursor-agent", "claude-code"];
const fourStates: readonly ProviderStatus[] = ["missing", "authenticated", "unauthenticated", "unknown"];
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Parent credential variable names surfaced as presence flags only. */
export const PARENT_CREDENTIAL_ALIASES = [
  "EVE_PARENT_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "ARC_ORCHESTRATOR_PARENT_API_KEY",
  "ARC_ORCHESTRATOR_API_KEY",
  "ARC_PI_API_KEY",
] as const;

const knownWorkerAliases = new Set<string>([
  ...Object.values(workerBinaryEnv),
  "CURSOR_AGENT_BIN",
  "CLAUDE_CODE_BIN",
  ...Object.values(workerBinaryDefaults),
]);

/** Parse the host-only argument surface. Unknown or conflicting flags fail closed. */
export function parseArgs(args: readonly string[]): HarnessArgs | undefined {
  const rest = [...args];
  while (rest[0] === "--") rest.shift();
  let action: HarnessAction | undefined;
  let mode: HarnessMode = "fake";
  let confirmReal = false;
  let envFromFile: string | undefined;
  let out: string | undefined;
  let checkout: string | undefined;
  let session = DEFAULT_SESSION_ID;
  const value = (arg: string, name: string): string | undefined | null => {
    if (!arg.startsWith(`--${name}=`)) return undefined;
    const v = arg.slice(name.length + 3);
    return v && !v.includes("\0") ? v : null;
  };
  for (const arg of rest) {
    if (arg === "--check" || arg === "--run") {
      if (action) return undefined;
      action = arg === "--check" ? "check" : "run";
      continue;
    }
    if (arg === "--confirm-real") { confirmReal = true; continue; }
    const m = value(arg, "mode");
    if (m !== undefined) {
      if (m !== "fake" && m !== "real") return undefined;
      mode = m;
      continue;
    }
    const e = value(arg, "env-from-file");
    if (e !== undefined) { if (e === null) return undefined; envFromFile = e; continue; }
    const o = value(arg, "out");
    if (o !== undefined) { if (o === null) return undefined; out = o; continue; }
    const c = value(arg, "checkout");
    if (c !== undefined) { if (c === null) return undefined; checkout = c; continue; }
    const s = value(arg, "session");
    if (s !== undefined) { if (s === null || !safeSegment.test(s)) return undefined; session = s; continue; }
    return undefined;
  }
  if (!action) return undefined;
  if (confirmReal && mode !== "real") return undefined;
  if (checkout && (mode !== "real" || action !== "run")) return undefined;
  return { action, mode, confirmReal, envFromFile, out, checkout, session };
}

const truthy = (v: string | undefined) => Boolean(v && v.trim() && !["0", "false", "no"].includes(v.trim().toLowerCase()));

/**
 * Automated contexts can never select real mode. ARC_E2E_FORCE and similar
 * variables are deliberately not an override.
 */
export function isAutomatedContext(...envs: NodeJS.ProcessEnv[]): boolean {
  return envs.some((env) =>
    truthy(env.CI) ||
    truthy(env.GITHUB_ACTIONS) ||
    env.NODE_TEST_CONTEXT !== undefined ||
    /^test(?::|$)/.test(env.npm_lifecycle_event ?? ""));
}

/** Drop harness control variables so they never reach runners or evidence. */
export function stripHarnessVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, v] of Object.entries(env)) if (!key.startsWith("ARC_E2E_")) next[key] = v;
  return next;
}

export async function readEnvFile(path: string | undefined, cwd = process.cwd()): Promise<Record<string, string>> {
  if (!path) return {};
  return stripHarnessVariables(parseDotEnvLocal(await readFile(resolve(cwd, path), "utf8"))) as Record<string, string>;
}

const present = (v: string | undefined) => Boolean(v?.trim());

export interface ParentProjection {
  provider: string;
  model: string;
  credential: "configured" | "missing";
  credentialAliases: Array<{ alias: string; present: boolean }>;
}

export function projectParent(env: NodeJS.ProcessEnv, cwd: string, envLocalPath: string): ParentProjection {
  const config = resolveParentProvider({ env, cwd, envLocalPath });
  return {
    provider: redactParentProviderText(config.provider, 80),
    model: redactParentProviderText(config.model, 160),
    credential: config.credentialPresent ? "configured" : "missing",
    credentialAliases: PARENT_CREDENTIAL_ALIASES.map((alias) => ({ alias, present: present(env[alias]) })),
  };
}

export type StatusProbe = (kind: WorkerKind, env: NodeJS.ProcessEnv, cwd: string) => Promise<ProviderStatus>;

export interface WorkerProjection {
  kind: WorkerKind;
  alias: string;
  present: boolean;
  status: ProviderStatus;
}

/** Offline fake probe: presence from resolution, status from a canned vendor blob. */
export function fakeStatusProbe(rawVendorOutput = '{"status":"authenticated"}'): StatusProbe {
  return async (kind, env, cwd) => {
    const resolved = await resolveWorkerBinary(kind, env, cwd);
    if (!resolved.path) return "missing";
    return classifyProviderStatus(0, rawVendorOutput);
  };
}

export async function projectWorkers(env: NodeJS.ProcessEnv, cwd: string, probe: StatusProbe): Promise<WorkerProjection[]> {
  const rows: WorkerProjection[] = [];
  for (const kind of kinds) {
    const resolved = await resolveWorkerBinary(kind, env, cwd);
    let status: ProviderStatus;
    try {
      const value = await probe(kind, env, cwd);
      status = fourStates.includes(value) ? value : "unknown";
    } catch {
      status = "unknown";
    }
    rows.push({ kind, alias: knownWorkerAliases.has(resolved.alias) ? resolved.alias : "unknown", present: Boolean(resolved.path), status });
  }
  return rows;
}

const excluded = new Set(["node_modules", ".git", ".output", ".eve", ".arc-pi", ".vercel"]);
function copyFilter(source: string): boolean {
  const name = basename(source);
  return !excluded.has(name) && !(name === ".env" || name.startsWith(".env."));
}

export interface FakeCheckout {
  root: string;
  checkout: string;
  arcPiHome: string;
  bin: string;
  runner: string;
  probe: string;
}

export interface FakeCheckoutOptions {
  sourceDir?: string;
  tmpRoot?: string;
  /** Strings the fake runner echoes into its raw output (redaction fixtures). */
  runnerNotes?: readonly string[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Throwaway checkout: mkdtemp + copy (no git clone), a scoped ARC_PI_HOME, an
 * inert PATH-default cursor-agent stub (never spawned), and a fake runner.
 */
export async function prepareFakeCheckout(options: FakeCheckoutOptions = {}): Promise<FakeCheckout> {
  const root = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "arc-e2e-acceptance-"));
  const checkout = join(root, "checkout");
  const arcPiHome = join(root, "arc-pi-home");
  const bin = join(root, "bin");
  await cp(options.sourceDir ?? repoRoot, checkout, { recursive: true, filter: copyFilter });
  await mkdir(arcPiHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  const stub = join(bin, workerBinaryDefaults["cursor-agent"]);
  await writeFile(stub, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  await chmod(stub, 0o755);

  const probe = join(root, "runner-env-probe.json");
  const notes = (options.runnerNotes ?? ["fake explore finished"]).slice(0, 20);
  const final = { status: "completed", summary: "fake explore finished", changes: [], verification: notes, risks: notes, next_actions: [] };
  const runner = join(root, "fake-arc-orchestrator.mjs");
  await writeFile(runner, [
    `#!${process.execPath}`,
    `import { writeFileSync } from "node:fs";`,
    `const keys = Object.keys(process.env);`,
    `writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ arcE2eVariables: keys.filter((k) => k.startsWith("ARC_E2E_")).length, argv: process.argv.slice(2, 3) }));`,
    `process.stderr.write('arc-orchestrator: event: {"v":1,"kind":"phase","seq":1,"at":1,"data":{"phase":"explore","status":"running"}}\\n');`,
    `process.stderr.write('arc-orchestrator: event: {"v":1,"kind":"phase","seq":2,"at":2,"data":{"phase":"explore","status":"completed"}}\\n');`,
    `process.stdout.write(${JSON.stringify(notes.join("\n"))} + "\\n");`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(final))} + "\\n");`,
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(runner, 0o755);
  return { root, checkout, arcPiHome, bin, runner, probe };
}

export function sessionRunsDir(arcPiHome: string, session = DEFAULT_SESSION_ID): string {
  return join(arcPiHome, "session-runs", session);
}

const recordStatuses = new Set(["running", "completed", "failed", "timed_out", "cancelled"]);
const recordPhases = new Set(["explore", "research", "plan", "implement", "verify", "deploy"]);
const recordModes = new Set(["analyze", "implement", "review"]);
const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : null;
const pick = <T extends string>(v: unknown, allowed: Set<string>): T | null => typeof v === "string" && allowed.has(v) ? v as T : null;

export interface CapturedRun {
  schemaVersion: 1;
  runRef: string | null;
  mode: string | null;
  phase: string | null;
  status: string | null;
  backend: "arc-orchestrator" | "other";
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string | null;
  endedAt: string | null;
  labelPresent: boolean;
  eventsSeen: number;
  workers: Array<{ kind: WorkerKind; alias: string; present: boolean }>;
}

/** Allow-list projection: no cwd, label text, model, prompt, or activity strings. */
export function projectSessionRun(raw: unknown): CapturedRun {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, any>;
  const aliases = r.workerBinaryAliases && typeof r.workerBinaryAliases === "object" ? r.workerBinaryAliases : {};
  const presence = r.workerBinaryPresent && typeof r.workerBinaryPresent === "object" ? r.workerBinaryPresent : {};
  const events = r.liveActivity?.eventsSeen;
  return {
    schemaVersion: 1,
    runRef: typeof r.runId === "string" && safeSegment.test(r.runId) ? r.runId : null,
    mode: pick(r.mode, recordModes),
    phase: pick(r.phase, recordPhases),
    status: pick(r.status, recordStatuses),
    backend: r.backend === "arc-orchestrator" ? "arc-orchestrator" : "other",
    exitCode: Number.isSafeInteger(r.exitCode) ? r.exitCode : null,
    timedOut: r.timedOut === true,
    startedAt: iso(r.startedAt),
    endedAt: iso(r.endedAt),
    labelPresent: typeof r.label === "string" && r.label.length > 0,
    eventsSeen: Number.isSafeInteger(events) && events >= 0 ? Math.min(events, 10_000) : 0,
    workers: kinds.map((kind) => ({
      kind,
      alias: typeof aliases[kind] === "string" && knownWorkerAliases.has(aliases[kind]) ? aliases[kind] : "unknown",
      present: presence[kind] === true,
    })),
  };
}

/** Read the newest session-run record, optionally filtered by host cwd. Read-only. */
export async function captureSessionRun(arcPiHome: string, session: string, filter: { cwd?: string } = {}): Promise<unknown | undefined> {
  const dir = sessionRunsDir(arcPiHome, session);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let best: { startedAt: string; record: unknown } | undefined;
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (filter.cwd && record?.cwd !== filter.cwd) continue;
      const startedAt = typeof record?.startedAt === "string" ? record.startedAt : "";
      if (!best || startedAt > best.startedAt) best = { startedAt, record };
    } catch {
      // Malformed or concurrently replaced records are skipped.
    }
  }
  return best?.record;
}

const sensitivePatterns: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /https?:\/\//i,
  /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/,
  /(?:^|\\n|\n|")\s*(?:user|assistant|system)\s*:/i,
  /(?:device|user)[_-]?code=/i,
];
const credentialKey = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OIDC/i;

/** Defense in depth over the already allow-listed evidence text. */
export function findSensitive(text: string, envValues: Record<string, string> = {}): number {
  let hits = sensitivePatterns.filter((pattern) => pattern.test(text)).length;
  for (const [key, v] of Object.entries(envValues)) {
    if (credentialKey.test(key) && v.length >= 6 && text.includes(v)) hits++;
  }
  return hits;
}

export interface Evidence {
  schemaVersion: 1;
  harness: "e2e-acceptance";
  mode: HarnessMode;
  verdict: "pass" | "fail" | "pending-operator";
  dailyHarness: "arc-pi";
  approvalPolicy: string;
  parent: ParentProjection;
  workers: Array<{ kind: WorkerKind; alias: string; present: boolean }>;
  preflight: WorkerProjection[];
  runner: { exitCode: number | null; status: string | null; phase: string | null; delegateStatus: string | null };
  ciExclusion: { automatedContext: boolean; arcE2eVariablesInRunnerEnv: number | null };
  checks: Record<string, boolean>;
  capturedEvidencePath: string | null;
}

type Output = (text: string) => void;
export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
  /** Real-mode worker probe; defaults to read-only providerStatus. Never login. */
  realStatus?: StatusProbe;
  /** Fake-mode worker probe; defaults to fakeStatusProbe(). */
  fakeStatus?: StatusProbe;
  sourceDir?: string;
  tmpRoot?: string;
  runnerNotes?: readonly string[];
  /** Real-mode registry home; defaults to ARC_PI_HOME or ~/.arc-pi. */
  arcPiHome?: string;
}

const noEnvLocal = () => join(tmpdir(), `.arc-e2e-no-env-local-${randomUUID()}`);

async function fakeRun(args: HarnessArgs, fileValues: Record<string, string>, options: HarnessOptions, automated: boolean): Promise<{ evidence: Evidence; evidencePath: string }> {
  const fixture = await prepareFakeCheckout({ sourceDir: options.sourceDir, tmpRoot: options.tmpRoot, runnerNotes: options.runnerNotes });
  const env = stripHarnessVariables({ PATH: fixture.bin, ...fileValues });
  const parent = projectParent(env, fixture.checkout, noEnvLocal());
  const preflight = await projectWorkers(env, fixture.checkout, options.fakeStatus ?? fakeStatusProbe());

  // Execute the real arc_delegate tool with a scoped process environment. The
  // harness stands in for the operator's Eve approval of a read-only Explore.
  const { default: tool } = await import("../agent/tools/arc_delegate.js");
  const approvalPolicy = String(await (tool as any).approval?.({}));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("ARC_E2E_")) delete process.env[key];
  for (const key of [...Object.values(workerBinaryEnv), "CURSOR_AGENT_BIN", "CLAUDE_CODE_BIN"]) delete process.env[key];
  Object.assign(process.env, env, { ARC_PI_HOME: fixture.arcPiHome, ARC_ORCHESTRATOR_BIN: fixture.runner });
  let delegateStatus: string | null = null;
  try {
    const result = await (tool as any).execute({
      phase: "explore",
      outcome: "Read-only acceptance probe of the throwaway checkout.",
      scope: "Read README.md only; report its first heading.",
      verification: "Return the final ARC JSON result.",
      preserved_behavior: "No files change.",
      prohibitions: "No writes, secrets, commits, or network.",
      label: "e2e-acceptance-fake",
      cwd: fixture.checkout,
    }, { abortSignal: new AbortController().signal, session: { id: args.session } });
    delegateStatus = result?.status === "completed" || result?.status === "blocked" ? result.status : null;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  const raw = await captureSessionRun(fixture.arcPiHome, args.session, { cwd: fixture.checkout });
  let arcE2eVariablesInRunnerEnv: number | null = null;
  try {
    const probe = JSON.parse(await readFile(fixture.probe, "utf8"));
    if (Number.isSafeInteger(probe.arcE2eVariables)) arcE2eVariablesInRunnerEnv = probe.arcE2eVariables;
  } catch {
    // Runner did not start; checks below fail.
  }
  return finish(args, fileValues, {
    parent, preflight, approvalPolicy, delegateStatus, raw, automated, arcE2eVariablesInRunnerEnv,
    outDir: args.out ? resolve(options.cwd ?? process.cwd(), args.out) : join(fixture.root, "evidence"),
  });
}

interface FinishInput {
  parent: ParentProjection;
  preflight: WorkerProjection[];
  approvalPolicy: string;
  delegateStatus: string | null;
  raw: unknown;
  automated: boolean;
  arcE2eVariablesInRunnerEnv: number | null;
  outDir: string;
  pending?: boolean;
}

async function finish(args: HarnessArgs, fileValues: Record<string, string>, input: FinishInput): Promise<{ evidence: Evidence; evidencePath: string }> {
  const captured = input.raw === undefined ? undefined : projectSessionRun(input.raw);
  await mkdir(input.outDir, { recursive: true });
  const capturedPath = join(input.outDir, CAPTURED_FILE);
  const evidencePath = join(input.outDir, EVIDENCE_FILE);
  const checks: Record<string, boolean> = {
    parentCredentialConfigured: input.parent.credential === "configured",
    authenticatedWorkerPresent: input.preflight.some((w) => w.present && w.status === "authenticated"),
    approvalGated: input.approvalPolicy === "user-approval",
    sessionRunCaptured: Boolean(captured),
    exploreCompleted: captured?.phase === "explore" && captured.status === "completed",
    runnerExitZero: captured?.exitCode === 0,
    runnerEnvWithoutHarnessVariables: input.arcE2eVariablesInRunnerEnv === null ? args.mode === "real" : input.arcE2eVariablesInRunnerEnv === 0,
  };
  if (args.mode === "fake") checks.delegateCompleted = input.delegateStatus === "completed";
  const evidence: Evidence = {
    schemaVersion: 1,
    harness: "e2e-acceptance",
    mode: args.mode,
    verdict: input.pending ? "pending-operator" : Object.values(checks).every(Boolean) ? "pass" : "fail",
    dailyHarness: "arc-pi",
    approvalPolicy: input.approvalPolicy,
    parent: input.parent,
    workers: captured?.workers ?? [],
    preflight: input.preflight,
    runner: { exitCode: captured?.exitCode ?? null, status: captured?.status ?? null, phase: captured?.phase ?? null, delegateStatus: input.delegateStatus },
    ciExclusion: { automatedContext: input.automated, arcE2eVariablesInRunnerEnv: input.arcE2eVariablesInRunnerEnv },
    checks,
    capturedEvidencePath: captured ? capturedPath : null,
  };
  const capturedText = captured ? JSON.stringify(captured) : "";
  const evidenceText = JSON.stringify(evidence);
  if (findSensitive(capturedText, fileValues) || findSensitive(evidenceText.replaceAll(input.outDir, ""), fileValues)) {
    throw new Error("evidence failed redaction scan");
  }
  if (Buffer.byteLength(evidenceText) > MAX_EVIDENCE_BYTES) throw new Error("evidence exceeds bound");
  if (captured) await writeFile(capturedPath, `${capturedText}\n`, { mode: 0o600 });
  await writeFile(evidencePath, `${evidenceText}\n`, { mode: 0o600 });
  return { evidence, evidencePath };
}

/** Run the host-only harness, projecting everything to bounded redacted JSON. */
export async function runCli(argv: readonly string[], options: HarnessOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const args = parseArgs(argv);
  if (!args) {
    stderr("e2e-acceptance: use --check or --run with --mode=fake|real\n");
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = options.env ?? process.env;
  const automated = isAutomatedContext(process.env, baseEnv);
  if (args.mode === "real") {
    if (automated) {
      stderr("e2e-acceptance: real mode is manual-only and refused in automated contexts\n");
      return 3;
    }
    if (!args.confirmReal) {
      stderr("e2e-acceptance: real mode requires --confirm-real\n");
      return 2;
    }
  }

  try {
    const fileValues = await readEnvFile(args.envFromFile, cwd);
    if (args.mode === "fake" && args.action === "check") {
      const bin = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "arc-e2e-check-"));
      try {
        await writeFile(join(bin, workerBinaryDefaults["cursor-agent"]), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
        const env = stripHarnessVariables({ PATH: bin, ...fileValues });
        const report = {
          harness: "e2e-acceptance", mode: "fake", action: "check", dailyHarness: "arc-pi",
          parent: projectParent(env, bin, noEnvLocal()),
          workers: await projectWorkers(env, bin, options.fakeStatus ?? fakeStatusProbe()),
        };
        const text = JSON.stringify(report);
        if (findSensitive(text, fileValues)) throw new Error("redaction");
        stdout(`${text}\n`);
        return 0;
      } finally {
        await rm(bin, { recursive: true, force: true });
      }
    }

    if (args.mode === "fake") {
      const { evidence, evidencePath } = await fakeRun(args, fileValues, options, automated);
      stdout(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
      return evidence.verdict === "pass" ? 0 : 1;
    }

    // Real mode: operator-initiated. Status probes are read-only; no login and
    // no browser launch happens here.
    const env = stripHarnessVariables({ ...baseEnv, ...fileValues });
    const parent = projectParent(env, cwd, args.envFromFile ? resolve(cwd, args.envFromFile) : join(cwd, ".env.local"));
    const preflight = await projectWorkers(env, cwd, options.realStatus ?? ((kind, e, c) => providerStatus(kind, e, c)));
    const ready = parent.credential === "configured" && preflight.some((w) => w.present && w.status === "authenticated");
    if (args.action === "check") {
      stdout(`${JSON.stringify({ harness: "e2e-acceptance", mode: "real", action: "check", dailyHarness: "arc-pi", ready, parent, workers: preflight })}\n`);
      return ready ? 0 : 1;
    }
    const { default: tool } = await import("../agent/tools/arc_delegate.js");
    const approvalPolicy = String(await (tool as any).approval?.({}));
    if (!args.checkout) {
      const fixture = await prepareFakeCheckout({ sourceDir: options.sourceDir ?? cwd, tmpRoot: options.tmpRoot });
      const { evidence, evidencePath } = await finish(args, fileValues, {
        parent, preflight, approvalPolicy, delegateStatus: null, raw: undefined, automated, arcE2eVariablesInRunnerEnv: null,
        outDir: args.out ? resolve(cwd, args.out) : join(fixture.root, "evidence"), pending: ready,
      });
      // The checkout path is operator-local guidance and is not written to evidence.
      stdout(`${JSON.stringify({ ...evidence, evidencePath, checkout: ready ? fixture.checkout : null })}\n`);
      return ready ? 0 : 1;
    }
    const checkout = resolve(cwd, args.checkout);
    const home = options.arcPiHome ?? env.ARC_PI_HOME ?? join(homedir(), ".arc-pi");
    const raw = await captureSessionRun(home, args.session, { cwd: checkout });
    const { evidence, evidencePath } = await finish(args, fileValues, {
      parent, preflight, approvalPolicy, delegateStatus: null, raw, automated, arcE2eVariablesInRunnerEnv: null,
      outDir: args.out ? resolve(cwd, args.out) : join(dirname(checkout), "evidence"),
    });
    stdout(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
    return evidence.verdict === "pass" ? 0 : 1;
  } catch {
    // Never echo provider output, paths, env values, or error text.
    stderr("e2e-acceptance: harness failed\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

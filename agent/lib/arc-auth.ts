import { spawn } from "node:child_process";
import { configuredWorkerBinaries, workerBinaryEnv, type WorkerKind } from "../lib/worker-binaries.js";

export type ProviderStatus = "missing" | "authenticated" | "unauthenticated" | "unknown";
export type AuthAction = "status" | "login";

const timeoutMs = 15_000;
const killGraceMs = 1_000;
const outputLimit = 8_192;

export interface ProviderAuthTimeouts {
  timeoutMs: number;
  killGraceMs: number;
}

/** Vendor output is inspected only for conservative, generic status markers. */
export function classifyProviderStatus(code: number | null, output: string): ProviderStatus {
  const json = parseJsonStatus(output);
  if (json.parsed) return json.status ?? "unknown";

  const text = output.toLowerCase();
  if (
    /\b(not|never)\s+(authenticated|authorized|logged\s+in|signed\s+in)\b/.test(text) ||
    /\b(unauthenticated|unauthorized|logged\s+out|signed\s+out)\b/.test(text) ||
    /\b(login|log\s+in|authentication|auth)\s+(required|needed)\b/.test(text) ||
    /\b(no|missing)\s+(credentials?|authentication|auth|active\s+session)\b/.test(text)
  ) {
    return "unauthenticated";
  }
  if (/\b(authenticated|authorized|logged\s+in|signed\s+in|login\s+successful|successfully\s+logged)\b/.test(text)) {
    return "authenticated";
  }
  // A clean exit without an explicit claim is not proof of authentication.
  void code;
  return "unknown";
}

function parseJsonStatus(output: string): { parsed: boolean; status?: ProviderStatus } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return { parsed: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { parsed: true };

  const record = parsed as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "logged_in"]) {
    const value = record[key];
    if (typeof value === "boolean") {
      return { parsed: true, status: value ? "authenticated" : "unauthenticated" };
    }
  }
  for (const key of ["status", "state", "authStatus", "loginStatus"]) {
    const status = classifyStatusValue(record[key]);
    if (status) return { parsed: true, status };
  }
  return { parsed: true };
}

function classifyStatusValue(value: unknown): ProviderStatus | undefined {
  if (typeof value === "boolean") return value ? "authenticated" : "unauthenticated";
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase().replace(/[_-]+/g, " ").trim();
  if (["authenticated", "authorized", "active", "ok", "logged in", "signed in"].includes(normalized)) {
    return "authenticated";
  }
  if (["unauthenticated", "unauthorized", "logged out", "signed out", "not authenticated", "not authorized", "login required", "missing", "none", "expired"].includes(normalized)) {
    return "unauthenticated";
  }
  return undefined;
}

const argvFor = (kind: WorkerKind, action: AuthAction): string[] =>
  action === "status"
    ? kind === "cursor-agent" ? ["status", "--format", "json"] : ["auth", "status", "--json"]
    : kind === "cursor-agent" ? ["login"] : ["auth", "login"];

type RunResult = { code: number | null; stdout: string; stderr: string; missing: boolean; timedOut: boolean };

function run(kind: WorkerKind, action: AuthAction, env: NodeJS.ProcessEnv, cwd: string, timing: ProviderAuthTimeouts): Promise<RunResult> {
  const bin = configuredWorkerBinaries(env, cwd)[kind];
  if (!bin) return Promise.resolve({ code: null, stdout: "", stderr: "", missing: true, timedOut: false });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputLength = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (value: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(value);
    };
    const timeoutResult = (): RunResult => ({ code: null, stdout: "", stderr: "", missing: false, timedOut: true });
    const child = spawn(bin, argvFor(kind, action), {
      cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      // Normalize even a compatibility fallback into the canonical variable so
      // every inherited runner environment observes the same selected path.
      // Credentials are never accepted as tool input, copied, or returned.
      env: { ...env, [workerBinaryEnv[kind]]: bin },
    });
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (outputLength >= outputLimit) return;
      const text = chunk.toString("utf8").slice(0, outputLimit - outputLength);
      outputLength += text.length;
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settleTimer = setTimeout(() => finish(timeoutResult()), timing.killGraceMs);
        settleTimer.unref();
      }, timing.killGraceMs);
      killTimer.unref();
    }, timing.timeoutMs);
    deadline.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(timedOut ? timeoutResult() : { code: null, stdout: "", stderr: "", missing: error.code === "ENOENT" || error.code === "EACCES", timedOut: false });
    });
    child.once("close", (code) => {
      finish(timedOut ? timeoutResult() : { code, stdout, stderr, missing: false, timedOut: false });
    });
  });
}

export async function providerStatus(
  kind: WorkerKind,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  timing: ProviderAuthTimeouts = { timeoutMs, killGraceMs },
): Promise<ProviderStatus> {
  const result = await run(kind, "status", env, cwd, timing);
  if (result.missing) return "missing";
  if (result.timedOut) return "unknown";
  for (const candidate of [result.stdout, result.stderr, `${result.stdout}\n${result.stderr}`]) {
    const json = parseJsonStatus(candidate);
    if (json.parsed) return json.status ?? "unknown";
  }
  return classifyProviderStatus(result.code, `${result.stdout}\n${result.stderr}`);
}

export async function providerLogin(
  kind: WorkerKind,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  timing: ProviderAuthTimeouts = { timeoutMs, killGraceMs },
): Promise<{ status: "completed" | "blocked" }> {
  const result = await run(kind, "login", env, cwd, timing);
  return { status: result.missing || result.timedOut || result.code !== 0 ? "blocked" : "completed" };
}

/*
 * Eve 0.54.3's authored-tool API has approval policies, but no operator-only
 * or model-discovery visibility flag (availability only supports root-session,
 * delegated-task-child, and requires-request-input).  Exporting an authored
 * login/status tool would therefore expose a credential-adjacent operation to
 * the model.  Fail closed: the implementation above is operator-callable by a
 * future host/operator adapter, while this file registers no model-callable
 * tool until Eve provides that boundary.
 */

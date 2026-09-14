import { spawn } from "node:child_process";
import { resolveWorkerBinary, workerBinaryEnv, type WorkerKind } from "../lib/worker-binaries.js";

export type ProviderStatus = "missing" | "authenticated" | "unauthenticated" | "unknown";
export type AuthAction = "status" | "login";
export type CredentialSource = "cursor-api-key";

const timeoutMs = 15_000;
const killGraceMs = 1_000;
const outputLimit = 8_192;
const browserUrlPattern = /https?:\/\/[^/\s]+/i;

export interface ProviderAuthTimeouts {
  timeoutMs: number;
  killGraceMs: number;
  signal?: AbortSignal;
}

export interface BrowserGuidance {
  url: string | null;
}

export interface ProviderLoginResult {
  status: "completed" | "blocked";
  postLoginStatus?: ProviderStatus;
  credentialSource?: CredentialSource;
  browserGuidance?: BrowserGuidance;
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

function classifyCaptured(result: RunResult): ProviderStatus {
  if (result.missing) return "missing";
  if (result.timedOut || result.cancelled) return "unknown";
  for (const candidate of [result.stdout, result.stderr, `${result.stdout}\n${result.stderr}`]) {
    const json = parseJsonStatus(candidate);
    if (json.parsed) return json.status ?? "unknown";
  }
  return classifyProviderStatus(result.code, `${result.stdout}\n${result.stderr}`);
}

function redactBrowserUrl(text: string): string | null | undefined {
  const match = text.match(browserUrlPattern);
  if (!match) return undefined;
  try {
    const parsed = new URL(match[0]);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function hasCursorApiKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CURSOR_API_KEY?.trim());
}

function discardCaptured(result: RunResult): void {
  result.stdout = "";
  result.stderr = "";
}

const argvFor = (kind: WorkerKind, action: AuthAction): string[] =>
  action === "status"
    ? kind === "cursor-agent" ? ["status", "--format", "json"] : ["auth", "status", "--json"]
    : kind === "cursor-agent" ? ["login"] : ["auth", "login"];

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
  cancelled: boolean;
  browserUrl?: string | null;
};

async function run(kind: WorkerKind, action: AuthAction, env: NodeJS.ProcessEnv, cwd: string, timing: ProviderAuthTimeouts): Promise<RunResult> {
  const resolved = await resolveWorkerBinary(kind, env, cwd);
  const bin = resolved.path;
  if (timing.signal?.aborted) {
    return { code: null, stdout: "", stderr: "", missing: false, timedOut: false, cancelled: true };
  }
  if (!bin) return { code: null, stdout: "", stderr: "", missing: true, timedOut: false, cancelled: false };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputLength = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killing = false;
    let capturedBrowserUrl: string | null | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const captureBrowser = kind === "cursor-agent" && action === "login";
    const discarded = (): Pick<RunResult, "code" | "stdout" | "stderr" | "missing"> => ({
      code: null, stdout: "", stderr: "", missing: false,
    });
    const finish = (value: RunResult) => {
      if (settled) return;
      settled = true;
      stdout = "";
      stderr = "";
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      timing.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const terminalResult = (asTimeout: boolean): RunResult => ({
      ...discarded(),
      timedOut: asTimeout,
      cancelled: !asTimeout,
      browserUrl: capturedBrowserUrl,
    });
    const escalate = (asTimeout: boolean) => {
      if (settled || killing) return;
      killing = true;
      if (asTimeout) timedOut = true;
      else cancelled = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settleTimer = setTimeout(() => finish(terminalResult(asTimeout)), timing.killGraceMs);
        settleTimer.unref();
      }, timing.killGraceMs);
      killTimer.unref();
    };
    const onAbort = () => escalate(false);
    const child = spawn(bin, argvFor(kind, action), {
      cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      // Normalize even a compatibility fallback into the canonical variable so
      // every inherited runner environment observes the same selected path.
      // Credentials are never accepted as tool input, copied, or returned.
      env: { ...env, [workerBinaryEnv[kind]]: bin },
    });
    const considerBrowserUrl = () => {
      if (!captureBrowser || capturedBrowserUrl !== undefined) return;
      const redacted = redactBrowserUrl(`${stdout}${stderr}`);
      if (redacted !== undefined) capturedBrowserUrl = redacted;
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (outputLength >= outputLimit) return;
      const text = chunk.toString("utf8").slice(0, outputLimit - outputLength);
      outputLength += text.length;
      if (target === "stdout") stdout += text;
      else stderr += text;
      considerBrowserUrl();
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const deadline = setTimeout(() => escalate(true), timing.timeoutMs);
    deadline.unref();
    timing.signal?.addEventListener("abort", onAbort, { once: true });
    if (timing.signal?.aborted) onAbort();
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(timedOut || cancelled
        ? terminalResult(timedOut)
        : { code: null, stdout: "", stderr: "", missing: error.code === "ENOENT" || error.code === "EACCES", timedOut: false, cancelled: false });
    });
    child.once("close", (code) => {
      finish(timedOut || cancelled
        ? terminalResult(timedOut)
        : { code, stdout, stderr, missing: false, timedOut: false, cancelled: false, browserUrl: capturedBrowserUrl });
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
  const status = classifyCaptured(result);
  discardCaptured(result);
  return status;
}

function blockedLogin(kind: WorkerKind, result: RunResult): ProviderLoginResult {
  const loginResult: ProviderLoginResult = { status: "blocked", postLoginStatus: "unknown" };
  if (kind === "cursor-agent" && result.browserUrl !== undefined) {
    loginResult.browserGuidance = { url: result.browserUrl };
  }
  return loginResult;
}

export async function providerLogin(
  kind: WorkerKind,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  timing: ProviderAuthTimeouts = { timeoutMs, killGraceMs },
): Promise<ProviderLoginResult> {
  if (timing.signal?.aborted) return { status: "blocked", postLoginStatus: "unknown" };

  if (kind === "cursor-agent" && hasCursorApiKey(env)) {
    const postLoginStatus = await providerStatus(kind, env, cwd, timing);
    if (timing.signal?.aborted) return { status: "blocked", postLoginStatus: "unknown" };
    return { status: "completed", postLoginStatus, credentialSource: "cursor-api-key" };
  }

  const result = await run(kind, "login", env, cwd, timing);
  if (result.cancelled) {
    discardCaptured(result);
    return { status: "blocked", postLoginStatus: "unknown" };
  }
  if (result.missing) {
    discardCaptured(result);
    return { status: "blocked", postLoginStatus: "missing" };
  }
  if (result.timedOut || result.code !== 0) {
    const loginResult = blockedLogin(kind, result);
    discardCaptured(result);
    return loginResult;
  }

  const browserGuidance = kind === "cursor-agent" && result.browserUrl !== undefined
    ? { url: result.browserUrl }
    : undefined;
  discardCaptured(result);
  let postLoginStatus: ProviderStatus;
  try {
    postLoginStatus = await providerStatus(kind, env, cwd, timing);
  } catch {
    postLoginStatus = "unknown";
  }
  if (timing.signal?.aborted) return { status: "blocked", postLoginStatus: "unknown" };
  const loginResult: ProviderLoginResult = { status: "completed", postLoginStatus };
  if (browserGuidance) loginResult.browserGuidance = browserGuidance;
  return loginResult;
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

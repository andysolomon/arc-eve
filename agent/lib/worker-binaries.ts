import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export type WorkerKind = "cursor-agent" | "claude-code";
export interface WorkerBinaries {
  "cursor-agent"?: string;
  "claude-code"?: string;
}
export type WorkerBinarySource = "canonical" | "alias" | "path";
export type WorkerBinaryReason = "missing" | "invalid" | "unavailable";
export interface ResolvedWorkerBinary {
  path?: string;
  reason?: WorkerBinaryReason;
  source: WorkerBinarySource;
  /** Env var or PATH default command name. Never a filesystem path. */
  alias: string;
}

const variables: Record<WorkerKind, string> = {
  "cursor-agent": "ARC_ORCHESTRATOR_CURSOR_BIN",
  "claude-code": "ARC_ORCHESTRATOR_CLAUDE_BIN",
};

const compatibilityVariables: Record<WorkerKind, string> = {
  "cursor-agent": "CURSOR_AGENT_BIN",
  "claude-code": "CLAUDE_CODE_BIN",
};

const defaults: Record<WorkerKind, string> = {
  "cursor-agent": "cursor-agent",
  "claude-code": "claude",
};

const kinds = Object.keys(variables) as WorkerKind[];

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  return trimmed;
}

function configuredSource(kind: WorkerKind, env: NodeJS.ProcessEnv): WorkerBinarySource | undefined {
  if (envValue(env[variables[kind]])) return "canonical";
  if (envValue(env[compatibilityVariables[kind]])) return "alias";
  return undefined;
}

/**
 * Env-only worker-binary configuration. Deliberately no PATH/vendor probing:
 * an operator must opt in with an explicit environment value.
 */
export function configuredWorkerBinaries(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): WorkerBinaries {
  const result: WorkerBinaries = {};
  for (const kind of kinds) {
    const canonical = env[variables[kind]]?.trim();
    const fallback = env[compatibilityVariables[kind]]?.trim();
    const value = canonical || fallback;
    if (!value || value.includes("\0")) continue;
    // Relative values are resolved against the same host cwd used by callers;
    // this also prevents a changed process cwd from changing the meaning.
    result[kind] = isAbsolute(value) ? value : resolve(cwd, value);
  }
  return result;
}

export async function executableWorkerBinaries(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<WorkerBinaries> {
  const configured = configuredWorkerBinaries(env, cwd);
  const result: WorkerBinaries = {};
  for (const kind of Object.keys(configured) as WorkerKind[]) {
    const path = configured[kind];
    if (path) {
      try {
        await access(path, constants.X_OK);
        result[kind] = path;
      } catch {
        // Invalid/unavailable configuration is intentionally omitted.
      }
    }
  }
  return result;
}

export function workerBinary(
  kind: WorkerKind,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  return configuredWorkerBinaries(env, cwd)[kind];
}

export function workerBinaryAliasName(kind: WorkerKind, env: NodeJS.ProcessEnv = process.env): string {
  const source = configuredSource(kind, env);
  if (source === "canonical") return variables[kind];
  if (source === "alias") return compatibilityVariables[kind];
  return defaults[kind];
}

async function inspectExecutable(path: string): Promise<"ok" | "invalid" | "unavailable"> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return "invalid";
    if (!(info.mode & 0o111)) return "unavailable";
  } catch {
    return "invalid";
  }
  try {
    await access(path, constants.X_OK);
    return "ok";
  } catch {
    return "unavailable";
  }
}

/**
 * Walk PATH entries from `env` and return the first regular file named `name`
 * that is executable (X_OK). Relative PATH entries are resolved against `cwd`.
 * Bare names only; names with separators are rejected so this never treats an
 * explicit path as a PATH lookup.
 */
export async function findExecutableInPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\")) return undefined;
  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(cwd, entry, name);
    if ((await inspectExecutable(candidate)) === "ok") return candidate;
  }
  return undefined;
}

/**
 * Resolve one worker binary with ARC Pi precedence: canonical env, then
 * compatibility alias, then PATH default. An explicit path that fails
 * X_OK/stat is fail-closed and never falls through to another binary.
 */
export async function resolveWorkerBinary(
  kind: WorkerKind,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<ResolvedWorkerBinary> {
  const alias = workerBinaryAliasName(kind, env);
  const source = configuredSource(kind, env) ?? "path";
  const configured = configuredWorkerBinaries(env, cwd)[kind];
  if (configured) {
    const inspection = await inspectExecutable(configured);
    if (inspection === "ok") return { path: configured, source, alias };
    return { reason: inspection, source, alias };
  }
  const path = await findExecutableInPath(defaults[kind], env, cwd);
  if (path) return { path, source: "path", alias };
  return { reason: "missing", source: "path", alias };
}

/** Env-configured executable, or PATH defaults when no override is set. */
export async function resolveWorkerBinaries(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<WorkerBinaries> {
  const result: WorkerBinaries = {};
  for (const kind of kinds) {
    const resolved = await resolveWorkerBinary(kind, env, cwd);
    if (resolved.path) result[kind] = resolved.path;
  }
  return result;
}

export const workerBinaryEnv = variables;
export const workerBinaryDefaults = defaults;

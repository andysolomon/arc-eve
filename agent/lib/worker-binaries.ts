import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type WorkerKind = "cursor-agent" | "claude-code";
export interface WorkerBinaries {
  "cursor-agent"?: string;
  "claude-code"?: string;
}

const variables: Record<WorkerKind, string> = {
  "cursor-agent": "ARC_ORCHESTRATOR_CURSOR_BIN",
  "claude-code": "ARC_ORCHESTRATOR_CLAUDE_BIN",
};

const compatibilityVariables: Record<WorkerKind, string> = {
  "cursor-agent": "CURSOR_AGENT_BIN",
  "claude-code": "CLAUDE_CODE_BIN",
};

/**
 * The sole worker-binary configuration boundary.  Deliberately no PATH/vendor
 * probing is done: an operator must opt in with an explicit environment value.
 */
export function configuredWorkerBinaries(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): WorkerBinaries {
  const result: WorkerBinaries = {};
  for (const kind of Object.keys(variables) as WorkerKind[]) {
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

export const workerBinaryEnv = variables;

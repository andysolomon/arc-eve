import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  formatMissingCredentialsMessage,
  redactParentProviderText,
  resolveParentProvider,
  type ParentProviderResolveOptions,
  type ResolvedParentProvider,
} from "../agent/lib/parent-provider.js";

export type ParentProviderAction = "status" | "check";

export interface ParentProviderCliOptions extends ParentProviderResolveOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Parse the two host-only commands accepted by this CLI. */
export function parseArgs(args: readonly string[]): ParentProviderAction | undefined {
  const normalized = [...args];
  while (normalized[0] === "--") normalized.shift();
  if (normalized.length !== 1) return undefined;
  return normalized[0] === "status" || normalized[0] === "check"
    ? normalized[0]
    : undefined;
}

function projectStatus(config: ResolvedParentProvider) {
  return {
    provider: redactParentProviderText(config.provider, 80),
    model: redactParentProviderText(config.model, 160),
    credential: config.credentialPresent ? "configured" : "missing",
  } as const;
}

/** Project parent configuration to bounded, generic operator JSON. */
export function runCli(args: readonly string[], options: ParentProviderCliOptions = {}): number {
  const action = parseArgs(args);
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  if (!action) {
    stderr("parent-provider: use status or check\n");
    return 2;
  }

  let config: ResolvedParentProvider;
  try {
    config = resolveParentProvider({
      env: options.env,
      cwd: options.cwd,
      envLocalPath: options.envLocalPath,
    });
  } catch {
    stderr("parent-provider: unable to read parent configuration\n");
    return 1;
  }

  stdout(`${JSON.stringify(projectStatus(config))}\n`);
  if (action === "check" && !config.credentialPresent) {
    stderr(`${formatMissingCredentialsMessage()}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}

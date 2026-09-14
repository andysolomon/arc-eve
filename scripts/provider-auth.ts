import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { providerLogin, providerStatus, type AuthAction, type ProviderStatus } from "../agent/lib/arc-auth.js";
import type { WorkerKind } from "../agent/lib/worker-binaries.js";

export interface ProviderAuthArgs {
  action: AuthAction;
  kind: WorkerKind;
}

const actions = new Set<AuthAction>(["status", "login"]);
const workers = new Set<WorkerKind>(["cursor-agent", "claude-code"]);

/** Parse exactly the two positional arguments accepted by this operator CLI. */
export function parseArgs(args: readonly string[]): ProviderAuthArgs | undefined {
  if (args.length !== 2) return undefined;
  const [action, kind] = args;
  if (!actions.has(action as AuthAction) || !workers.has(kind as WorkerKind)) return undefined;
  return { action: action as AuthAction, kind: kind as WorkerKind };
}

type Output = (text: string) => void;
export interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  status?: typeof providerStatus;
  login?: typeof providerLogin;
}

/** Run the host-only adapter, projecting provider results to generic JSON. */
export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  if (!parsed) {
    stderr("provider-auth: invalid arguments\n");
    return 2;
  }

  try {
    const status: ProviderStatus | "completed" | "blocked" = parsed.action === "status"
      ? await (options.status ?? providerStatus)(parsed.kind)
      : (await (options.login ?? providerLogin)(parsed.kind)).status;
    stdout(`${JSON.stringify({ provider: parsed.kind, status })}\n`);
    return 0;
  } catch {
    // Do not expose provider errors, output, paths, or credentials.
    stderr("provider-auth: operation failed\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // pnpm forwards its conventional `--` separator to the script runner.
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  process.exitCode = await runCli(args);
}

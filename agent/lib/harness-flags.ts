import { readDotEnvLocal } from "./parent-provider.js";

/**
 * Harness efficiency flags.
 *
 * Every flag defaults to the pre-flag behavior, so an unset environment
 * reproduces the baseline measured in docs/architecture/token-efficiency.md.
 * Flags are read from process.env first and .env.local second, like the
 * parent-provider settings. Tool slots and instructions are compiled when
 * eve dev starts (and on rebuild), so restart eve dev after changing one.
 */
export interface HarnessFlags {
  /**
   * EVE_PARENT_LEAN_TOOLS=1 removes default tools the parent cannot use in
   * its just-bash sandbox or that the worker-plane decision reserves for the
   * runner: web_fetch, web_search, todo, and write_file. bash, read_file,
   * ask_question, and arc_delegate stay.
   */
  leanTools: boolean;
  /**
   * EVE_PARENT_LEAN_INSTRUCTIONS=1 selects the shorter system instructions
   * variant (product and environment facts only) over the original text.
   */
  leanInstructions: boolean;
  /**
   * EVE_PARENT_PROMPT_CACHE_KEY=off stops sending OpenAI's prompt_cache_key
   * routing hint. Default on; it is only attached for the openai provider.
   */
  promptCacheKey: boolean;
  /**
   * EVE_PARENT_PROMPT_CACHE_RETENTION=24h asks OpenAI to keep the cached
   * prefix for a day instead of minutes. Off by default because unsupported
   * models reject the request field.
   */
  promptCacheRetention: "24h" | undefined;
}

const onValues = new Set(["1", "true", "on", "yes"]);
const offValues = new Set(["0", "false", "off", "no"]);

function flagValue(name: string, env: NodeJS.ProcessEnv, file: Record<string, string>): string | undefined {
  const raw = env[name] ?? file[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || undefined;
}

function booleanFlag(name: string, defaultValue: boolean, env: NodeJS.ProcessEnv, file: Record<string, string>): boolean {
  const value = flagValue(name, env, file);
  if (value === undefined) return defaultValue;
  if (onValues.has(value)) return true;
  if (offValues.has(value)) return false;
  return defaultValue;
}

export function resolveHarnessFlags(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): HarnessFlags {
  const file = readDotEnvLocal(cwd);
  const retention = flagValue("EVE_PARENT_PROMPT_CACHE_RETENTION", env, file);
  return {
    leanTools: booleanFlag("EVE_PARENT_LEAN_TOOLS", false, env, file),
    leanInstructions: booleanFlag("EVE_PARENT_LEAN_INSTRUCTIONS", false, env, file),
    promptCacheKey: booleanFlag("EVE_PARENT_PROMPT_CACHE_KEY", true, env, file),
    promptCacheRetention: retention === "24h" ? "24h" : undefined,
  };
}

/** Flags resolved once at module load, for authored slots that must be static. */
export const harnessFlags: HarnessFlags = resolveHarnessFlags();

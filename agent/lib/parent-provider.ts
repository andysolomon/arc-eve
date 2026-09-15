import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const DEFAULT_PARENT_PROVIDER = "openai";
export const DEFAULT_PARENT_MODEL = "gpt-5-mini";
export const DEFAULT_PARENT_MODEL_STRING = `${DEFAULT_PARENT_PROVIDER}/${DEFAULT_PARENT_MODEL}`;

export interface ParentProviderResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  envLocalPath?: string;
}

export interface ResolvedParentProvider {
  provider: string;
  /** Provider-qualified model string accepted by Eve's string-model config. */
  model: string;
  /**
   * Bare model id after the first slash when the configured model was already
   * provider-qualified (e.g. MiniMax/MiniMax-M3 → MiniMax-M3). Absent when the
   * qualifier is added from the provider setting.
   */
  modelShortName?: string;
  baseUrl?: string;
  /** Only presence is exposed; credential material is never returned. */
  credentialPresent: boolean;
}

type ParentSetting = "provider" | "model" | "baseUrl" | "apiKey";

const canonicalVariables: Record<ParentSetting, string> = {
  provider: "EVE_PARENT_PROVIDER",
  model: "EVE_PARENT_MODEL",
  baseUrl: "EVE_PARENT_BASE_URL",
  apiKey: "EVE_PARENT_API_KEY",
};

// Keep ARC Pi-style names available as compatibility fallbacks. The canonical
// EVE_PARENT_* variables always win within the same source.
const compatibilityVariables: Record<ParentSetting, readonly string[]> = {
  provider: [
    "ARC_ORCHESTRATOR_PARENT_PROVIDER",
    "ARC_ORCHESTRATOR_PROVIDER",
    "ARC_PI_PROVIDER",
    "EVE_PROVIDER",
    "PARENT_PROVIDER",
  ],
  model: [
    "ARC_ORCHESTRATOR_PARENT_MODEL",
    "ARC_ORCHESTRATOR_MODEL",
    "ARC_PI_MODEL",
    "EVE_MODEL",
    "PARENT_MODEL",
  ],
  baseUrl: [
    "ARC_ORCHESTRATOR_PARENT_BASE_URL",
    "ARC_ORCHESTRATOR_BASE_URL",
    "ARC_PI_BASE_URL",
    "EVE_BASE_URL",
    "PARENT_BASE_URL",
  ],
  apiKey: [
    "ARC_ORCHESTRATOR_PARENT_API_KEY",
    "ARC_ORCHESTRATOR_API_KEY",
    "ARC_PI_API_KEY",
    "EVE_API_KEY",
    "PARENT_API_KEY",
    // This is the credential name consumed by Eve's string-model gateway.
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
  ],
};

const controlCharacters = /[\u0000-\u001f\u007f]/;

function settingValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || controlCharacters.test(trimmed)) return undefined;
  return trimmed;
}

/** Parse the small KEY=value subset needed from .env.local. */
export function parseDotEnvLocal(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closing = value.lastIndexOf(quote);
      if (closing <= 0) continue;
      const trailing = value.slice(closing + 1).trim();
      if (trailing && !trailing.startsWith("#")) continue;
      value = value.slice(1, closing);
      if (quote === '"') value = value.replace(/\\([\\"])/g, "$1");
    } else {
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }

    const normalized = settingValue(value);
    if (normalized !== undefined) values[key] = normalized;
  }
  return values;
}

export function readDotEnvLocal(cwd = process.cwd(), envLocalPath?: string): Record<string, string> {
  try {
    const path = envLocalPath
      ? isAbsolute(envLocalPath) ? envLocalPath : join(cwd, envLocalPath)
      : join(cwd, ".env.local");
    return parseDotEnvLocal(readFileSync(path, "utf8"));
  } catch {
    // Missing, unreadable, or malformed dotenv input must not make the default
    // Eve model unavailable at boot.
    return {};
  }
}

/**
 * Idempotent .env.local bootstrap that only sets process.env values that are
 * not already present. Process environment always wins; .env.local is the
 * fallback. Missing/unreadable file is a no-op. Returns a record so callers
 * (and tests) can introspect what was loaded vs skipped.
 */
export function loadDotEnvIntoProcessEnv(
  cwd = process.cwd(),
  envLocalPath?: string,
): { loaded: string[]; skipped: string[]; file: string | undefined } {
  const file = (() => {
    try {
      return envLocalPath
        ? isAbsolute(envLocalPath) ? envLocalPath : join(cwd, envLocalPath)
        : join(cwd, ".env.local");
    } catch {
      return undefined;
    }
  })();
  const values = readDotEnvLocal(cwd, envLocalPath);
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    } else {
      skipped.push(key);
    }
  }
  return { loaded, skipped, file };
}

function isResolveOptions(value: ParentProviderResolveOptions | NodeJS.ProcessEnv): value is ParentProviderResolveOptions {
  return "env" in value || "cwd" in value || "envLocalPath" in value;
}

function selectSetting(
  setting: ParentSetting,
  env: NodeJS.ProcessEnv,
  fileValues: Record<string, string>,
): string | undefined {
  const names = [canonicalVariables[setting], ...compatibilityVariables[setting]];
  // Process values have source precedence over .env.local values. Within a
  // source the canonical variable wins over every compatibility alias.
  for (const source of [env, fileValues]) {
    for (const name of names) {
      const value = settingValue(source[name]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function providerQualifiedModel(provider: string, model: string): string {
  return model.includes("/") ? model : `${provider}/${model}`;
}

function qualifiedModelShortName(model: string): string | undefined {
  const separator = model.indexOf("/");
  return separator >= 0 ? model.slice(separator + 1) : undefined;
}

export function resolveParentProvider(options?: ParentProviderResolveOptions): ResolvedParentProvider;
export function resolveParentProvider(env?: NodeJS.ProcessEnv, cwd?: string): ResolvedParentProvider;
export function resolveParentProvider(
  input?: ParentProviderResolveOptions | NodeJS.ProcessEnv,
  positionalCwd = process.cwd(),
): ResolvedParentProvider {
  const positionalEnvironment = input !== undefined && arguments.length > 1;
  const options = input === undefined
    ? {}
    : !positionalEnvironment && (isResolveOptions(input) || Object.keys(input).length === 0)
      ? input as ParentProviderResolveOptions
      : undefined;
  const env = options?.env ?? (options ? process.env : input as NodeJS.ProcessEnv);
  const cwd = options?.cwd ?? (options ? process.cwd() : positionalCwd);
  const fileValues = readDotEnvLocal(cwd, options?.envLocalPath);
  const provider = selectSetting("provider", env, fileValues) ?? DEFAULT_PARENT_PROVIDER;
  const modelId = selectSetting("model", env, fileValues) ?? DEFAULT_PARENT_MODEL;
  const baseUrl = selectSetting("baseUrl", env, fileValues);
  const credential = selectSetting("apiKey", env, fileValues);
  const modelShortName = modelId.includes("/") ? qualifiedModelShortName(modelId) : undefined;

  return {
    provider,
    model: providerQualifiedModel(provider, modelId),
    ...(modelShortName ? { modelShortName } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    credentialPresent: credential !== undefined,
  };
}

const secretGlobal = /(?:token|secret|password|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi;
const credentialLikeGlobal = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----END [A-Z0-9 ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{10,}|xox[A-Za-z]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{2,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2})/g;

/** Redact the same assignment and credential families admitted by arc-runtime. */
export function redactParentProviderText(value: string, max = 240): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(secretGlobal, "[redacted]")
    .replace(credentialLikeGlobal, "[redacted]")
    .slice(0, max);
}

/** Generic guidance intentionally contains no provider diagnostics or values. */
export function formatMissingCredentialsMessage(_detail?: unknown): string {
  return "Parent provider credentials are missing; set EVE_PARENT_API_KEY (or AI_GATEWAY_API_KEY) in .env.local, then restart eve dev.";
}

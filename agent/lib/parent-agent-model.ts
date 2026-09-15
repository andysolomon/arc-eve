import type { ResolvedParentProvider } from "./parent-provider.js";

/**
 * OpenAI-compatible provider factory accepted by Eve's LanguageModel slot.
 * Most OpenAI-compat endpoints (MiniMax, OpenRouter-style, vLLM, ...) expose
 * chat completions at /v1/chat/completions; the AI SDK's `chat(modelId)`
 * factory method targets that endpoint while the default `(modelId)` call
 * targets the Responses API at /v1/responses. We always prefer `.chat()`
 * for direct routing because every OpenAI-compatible provider we expect to
 * consume starts here (MiniMax, OpenRouter, Together, etc.) exposes it.
 */
export type OpenAICompatibleFactory<TModel = unknown> = (
  options: { baseURL?: string; apiKey?: string },
) => {
  (modelId: string): TModel;
  chat(modelId: string): TModel;
};

export type ParentAgentDefine<TModel, TResult> = (
  definition: { model: string | TModel; modelContextWindowTokens?: number },
) => TResult;

/**
 * Conservative fallback context window for direct-routed providers.
 *
 * Eve compiles the "primary compaction trigger model" and needs a context
 * window to size its compaction threshold. For gateway models Eve looks the
 * value up in the AI Gateway catalog; for a direct OpenAI-compatible model
 * there is no catalog entry, so Eve fails compilation unless the authored
 * definition supplies `modelContextWindowTokens`. This default is
 * intentionally lower than most modern hosted models so compaction triggers
 * early rather than overflowing. Override with
 * `EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS` when the real window differs.
 */
export const DEFAULT_DIRECT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Shape passed to `defineAgent` — a model plus its optional context window. */
export interface ParentAgentDefinitionFragment<TModel> {
  model: string | TModel;
  modelContextWindowTokens?: number;
}

function bareModelName(resolved: ResolvedParentProvider): string {
  if (resolved.modelShortName) return resolved.modelShortName;
  const separator = resolved.model.indexOf("/");
  return separator >= 0 ? resolved.model.slice(separator + 1) : resolved.model;
}

/**
 * Gateway string model when no base URL is set; otherwise a direct
 * OpenAI-compatible LanguageModel via the injected factory's `.chat()`
 * factory method (chat-completions endpoint).
 */
export function parentAgentModel<TModel>(
  resolved: ResolvedParentProvider,
  createOpenAI: OpenAICompatibleFactory<TModel>,
  env: NodeJS.ProcessEnv = process.env,
): string | TModel {
  if (!resolved.baseUrl) return resolved.model;
  return createOpenAI({
    baseURL: resolved.baseUrl,
    apiKey: env.EVE_PARENT_API_KEY ?? "",
  }).chat(bareModelName(resolved));
}

/**
 * The full `defineAgent` argument. Direct routing (a configured base URL)
 * always carries a context window so Eve can compile compaction without an
 * AI Gateway catalog lookup; gateway routing keeps the bare string model and
 * lets Eve resolve metadata itself.
 */
export function parentAgentDefinition<TModel>(
  resolved: ResolvedParentProvider,
  createOpenAI: OpenAICompatibleFactory<TModel>,
  env: NodeJS.ProcessEnv = process.env,
): ParentAgentDefinitionFragment<TModel> {
  const model = parentAgentModel(resolved, createOpenAI, env);
  if (!resolved.baseUrl) return { model };
  return {
    model,
    modelContextWindowTokens: resolved.modelContextWindowTokens ?? DEFAULT_DIRECT_CONTEXT_WINDOW_TOKENS,
  };
}

/** Thin defineAgent wrapper so tests can inject the factory without loading eve. */
export function defineParentAgent<TModel, TResult>(
  defineAgent: ParentAgentDefine<TModel, TResult>,
  resolved: ResolvedParentProvider,
  createOpenAI: OpenAICompatibleFactory<TModel>,
  env: NodeJS.ProcessEnv = process.env,
): TResult {
  return defineAgent(parentAgentDefinition(resolved, createOpenAI, env));
}

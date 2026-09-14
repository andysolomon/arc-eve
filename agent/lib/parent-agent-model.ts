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
  definition: { model: string | TModel },
) => TResult;

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

/** Thin defineAgent wrapper so tests can inject the factory without loading eve. */
export function defineParentAgent<TModel, TResult>(
  defineAgent: ParentAgentDefine<TModel, TResult>,
  resolved: ResolvedParentProvider,
  createOpenAI: OpenAICompatibleFactory<TModel>,
  env: NodeJS.ProcessEnv = process.env,
): TResult {
  return defineAgent({ model: parentAgentModel(resolved, createOpenAI, env) });
}

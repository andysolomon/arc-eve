import type { ResolvedParentProvider } from "./parent-provider.js";

/** OpenAI-compatible provider factory accepted by Eve's LanguageModel slot. */
export type OpenAICompatibleFactory<TModel = unknown> = (
  options: { baseURL?: string; apiKey?: string },
) => (modelId: string) => TModel;

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
 * OpenAI-compatible LanguageModel from the injected factory.
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
  })(bareModelName(resolved));
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

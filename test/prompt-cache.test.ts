import test from "node:test";
import assert from "node:assert/strict";
import { isOpenAIEndpoint, PARENT_PROMPT_CACHE_KEY, parentAgentDefinition, parentModelOptions, type OpenAICompatibleFactory } from "../agent/lib/parent-agent-model.js";
import { resolveParentProvider } from "../agent/lib/parent-provider.js";

const isolatedCwd = "/path/that/does/not/exist";

test("prompt cache options are attached only for the real OpenAI endpoint", () => {
  assert.equal(isOpenAIEndpoint({ provider: "openai" }), true);
  assert.equal(isOpenAIEndpoint({ provider: "openai", baseUrl: "https://api.openai.com/v1" }), true);
  assert.equal(isOpenAIEndpoint({ provider: "openai", baseUrl: "https://api.minimax.io/v1" }), false);
  assert.equal(isOpenAIEndpoint({ provider: "MiniMax" }), false);
  assert.equal(isOpenAIEndpoint({ provider: "openai", baseUrl: "not a url" }), false);

  const flags = { promptCacheKey: true, promptCacheRetention: undefined };
  assert.deepEqual(parentModelOptions({ provider: "openai" }, flags), { providerOptions: { openai: { promptCacheKey: PARENT_PROMPT_CACHE_KEY } } });
  assert.deepEqual(parentModelOptions({ provider: "openai" }, { promptCacheKey: true, promptCacheRetention: "24h" }), { providerOptions: { openai: { promptCacheKey: PARENT_PROMPT_CACHE_KEY, promptCacheRetention: "24h" } } });
  assert.equal(parentModelOptions({ provider: "openai" }, { promptCacheKey: false, promptCacheRetention: undefined }), undefined);
  assert.equal(parentModelOptions({ provider: "MiniMax", baseUrl: "https://api.minimax.io/v1" }, flags), undefined);
});

test("defineAgent fragment carries modelOptions for gateway OpenAI and omits them for other direct providers", () => {
  const factory: OpenAICompatibleFactory = () => {
    const provider = ((modelId: string) => ({ modelId })) as ReturnType<OpenAICompatibleFactory> & { chat: (id: string) => unknown };
    provider.chat = (modelId: string) => ({ modelId, chat: true });
    return provider;
  };
  const gateway = resolveParentProvider({ cwd: isolatedCwd, env: {} });
  assert.deepEqual(parentAgentDefinition(gateway, factory, {}, { promptCacheKey: true, promptCacheRetention: undefined }), {
    model: "openai/gpt-5-mini",
    modelOptions: { providerOptions: { openai: { promptCacheKey: PARENT_PROMPT_CACHE_KEY } } },
  });
  assert.deepEqual(parentAgentDefinition(gateway, factory, {}, { promptCacheKey: false, promptCacheRetention: undefined }), { model: "openai/gpt-5-mini" });

  const minimax = resolveParentProvider({ cwd: isolatedCwd, env: { EVE_PARENT_PROVIDER: "MiniMax", EVE_PARENT_MODEL: "MiniMax-M3", EVE_PARENT_BASE_URL: "https://api.minimax.io/v1" } });
  const fragment = parentAgentDefinition(minimax, factory, {}, { promptCacheKey: true, promptCacheRetention: "24h" });
  assert.equal("modelOptions" in fragment, false);
  assert.equal(fragment.modelContextWindowTokens, 128_000);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIRECT_CONTEXT_WINDOW_TOKENS,
  defineParentAgent,
  parentAgentDefinition,
  type OpenAICompatibleFactory,
} from "../agent/lib/parent-agent-model.js";
import { resolveParentProvider } from "../agent/lib/parent-provider.js";

const isolatedCwd = "/path/that/does/not/exist";
const probeKey = "sk-test-probe-1234567890abcdef";
const probeAssignment = `EVE_PARENT_API_KEY=${probeKey}`;

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      key,
      ...collectStrings(nested),
    ]);
  }
  return [];
}

function assertNoCredentialEcho(snapshot: unknown): void {
  const captured = collectStrings(snapshot);
  for (const value of captured) {
    assert.equal(value.includes(probeKey), false);
    assert.equal(value.includes(probeAssignment), false);
  }
}

test("defineAgent receives the createOpenAI language-model object via .chat() when baseUrl is set", () => {
  const env = {
    EVE_PARENT_PROVIDER: "MiniMax",
    EVE_PARENT_MODEL: "MiniMax/MiniMax-M3",
    EVE_PARENT_BASE_URL: "https://api.minimax.io/v1",
    EVE_PARENT_API_KEY: probeKey,
  };
  const resolved = resolveParentProvider({ cwd: isolatedCwd, env });
  const languageModel = {
    specificationVersion: "v3",
    provider: "openai.compatible.chat",
    modelId: "MiniMax-M3",
  };
  const factoryMeta: Array<{ baseURL?: string; calledWithBareModel: string }> = [];
  const createOpenAI: OpenAICompatibleFactory = (options) => {
    const provider = ((modelId: string) => ({ specificationVersion: "v3", provider: "openai.compatible", modelId })) as ReturnType<OpenAICompatibleFactory> & { chat: (id: string) => unknown };
    provider.chat = (modelId: string) => {
      factoryMeta.push({ baseURL: options.baseURL, calledWithBareModel: modelId });
      return languageModel;
    };
    return provider;
  };
  const defineCalls: Array<{ model: unknown; modelContextWindowTokens?: number }> = [];

  defineParentAgent((definition) => {
    defineCalls.push(definition);
    return definition;
  }, resolved, createOpenAI, env);

  assert.equal(resolved.baseUrl, "https://api.minimax.io/v1");
  assert.equal(resolved.modelShortName, "MiniMax-M3");
  assert.equal(defineCalls.length, 1);
  assert.equal(typeof defineCalls[0].model, "object");
  assert.equal(defineCalls[0].model, languageModel);
  // Direct routing must carry a context window, otherwise eve fails
  // compaction compilation for a non-gateway provider.
  assert.equal(defineCalls[0].modelContextWindowTokens, DEFAULT_DIRECT_CONTEXT_WINDOW_TOKENS);
  assert.deepEqual(factoryMeta, [{
    baseURL: "https://api.minimax.io/v1",
    calledWithBareModel: "MiniMax-M3",
  }]);

  const processSnapshot = {
    defineCalls,
    factoryMeta,
    resolved,
    envNames: Object.keys(env).sort(),
    stdout: "",
    stderr: "",
  };
  assertNoCredentialEcho(processSnapshot);
  assert.equal(JSON.stringify(processSnapshot).includes(probeAssignment), false);
  assert.equal(JSON.stringify(processSnapshot).includes(probeKey), false);
});

test("explicit EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS overrides the direct-routing default", () => {
  const env = {
    EVE_PARENT_PROVIDER: "MiniMax",
    EVE_PARENT_MODEL: "MiniMax/MiniMax-M3",
    EVE_PARENT_BASE_URL: "https://api.minimax.io/v1",
    EVE_PARENT_API_KEY: probeKey,
    EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS: "200000",
  };
  const resolved = resolveParentProvider({ cwd: isolatedCwd, env });
  assert.equal(resolved.modelContextWindowTokens, 200000);

  const fragment = parentAgentDefinition(resolved, openAIFactory(), env);
  assert.equal(fragment.modelContextWindowTokens, 200000);

  const { EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS: _dropped, ...withoutOverride } = env;
  const fallbackResolved = resolveParentProvider({ cwd: isolatedCwd, env: withoutOverride });
  assert.equal(fallbackResolved.modelContextWindowTokens, undefined);
  assert.equal(
    parentAgentDefinition(fallbackResolved, openAIFactory(), withoutOverride).modelContextWindowTokens,
    DEFAULT_DIRECT_CONTEXT_WINDOW_TOKENS,
  );

  const malformed = resolveParentProvider({
    cwd: isolatedCwd,
    env: { ...env, EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS: "not-a-number" },
  });
  assert.equal(malformed.modelContextWindowTokens, undefined);
});

function openAIFactory(): OpenAICompatibleFactory {
  return (options) => {
    const provider = ((modelId: string) => ({ specificationVersion: "v3", provider: "openai.compatible", modelId, baseURL: options.baseURL })) as ReturnType<OpenAICompatibleFactory>;
    provider.chat = (modelId: string) => ({ specificationVersion: "v3", provider: "openai.compatible.chat", modelId, baseURL: options.baseURL });
    return provider;
  };
}

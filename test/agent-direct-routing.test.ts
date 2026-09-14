import test from "node:test";
import assert from "node:assert/strict";
import {
  defineParentAgent,
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

test("defineAgent receives the resolved string model when no baseUrl is configured", () => {
  const resolved = resolveParentProvider({ cwd: isolatedCwd, env: {} });
  const defineCalls: Array<{ model: unknown }> = [];
  const factoryCalls: unknown[] = [];
  const createOpenAI: OpenAICompatibleFactory = (options) => {
    factoryCalls.push(options);
    return () => ({ specificationVersion: "v3", provider: "openai", modelId: "unused" });
  };

  defineParentAgent((definition) => {
    defineCalls.push(definition);
    return definition;
  }, resolved, createOpenAI, {});

  assert.equal(resolved.baseUrl, undefined);
  assert.equal(defineCalls.length, 1);
  assert.equal(typeof defineCalls[0].model, "string");
  assert.equal(defineCalls[0].model, resolved.model);
  assert.equal(defineCalls[0].model, "openai/gpt-5-mini");
  assert.deepEqual(factoryCalls, []);
  assertNoCredentialEcho({ defineCalls, factoryCalls, resolved });
});

test("defineAgent receives the createOpenAI language-model object when baseUrl is set", () => {
  const env = {
    EVE_PARENT_PROVIDER: "MiniMax",
    EVE_PARENT_MODEL: "MiniMax/MiniMax-M3",
    EVE_PARENT_BASE_URL: "https://api.minimax.io/v1",
    EVE_PARENT_API_KEY: probeKey,
  };
  const resolved = resolveParentProvider({ cwd: isolatedCwd, env });
  const languageModel = {
    specificationVersion: "v3",
    provider: "openai.compatible",
    modelId: "MiniMax-M3",
  };
  const factoryMeta: Array<{ baseURL?: string; calledWithBareModel: string }> = [];
  const createOpenAI: OpenAICompatibleFactory = (options) => {
    return (modelId) => {
      factoryMeta.push({ baseURL: options.baseURL, calledWithBareModel: modelId });
      return languageModel;
    };
  };
  const defineCalls: Array<{ model: unknown }> = [];

  defineParentAgent((definition) => {
    defineCalls.push(definition);
    return definition;
  }, resolved, createOpenAI, env);

  assert.equal(resolved.baseUrl, "https://api.minimax.io/v1");
  assert.equal(resolved.modelShortName, "MiniMax-M3");
  assert.equal(defineCalls.length, 1);
  assert.equal(typeof defineCalls[0].model, "object");
  assert.equal(defineCalls[0].model, languageModel);
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

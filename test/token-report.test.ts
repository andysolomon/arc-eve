import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, collectFacts, formatReport, parseArgs, priceFor, readTraceStore, runCli, stepCostUsd, DEFAULT_PRICES } from "../scripts/token-report.js";

type Attr = { key: string; value: Record<string, unknown> };
const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } });

function span(name: string, attrs: Attr[], startTimeUnixNano = "1") {
  return { traceId: "t", spanId: "s", name, kind: 1, startTimeUnixNano, endTimeUnixNano: startTimeUnixNano, attributes: attrs, events: [] };
}

function step(conversation: string, turn: string, index: number, usage: { input: number; cached: number; output: number }, model = "openai/gpt-5-mini", start = "1") {
  return span("agent.step", [
    str("gen_ai.conversation.id", conversation), str("agent.turn.id", turn), int("agent.step.index", index),
    str("agent.model.id", model), str("agent.model.provider", "openai.chat"),
    int("agent.usage.input_tokens", usage.input), int("agent.usage.cache_read_tokens", usage.cached), int("agent.usage.output_tokens", usage.output),
  ], start);
}

function tool(conversation: string, name: string, error = false) {
  return span("execute_tool " + name, [str("gen_ai.conversation.id", conversation), str("gen_ai.tool.name", name), ...(error ? [str("error.type", "Error")] : [])]);
}

function document(spans: unknown[]) {
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: "eve.agent" }, spans }] }] };
}

test("collectFacts reads usage, tool calls, and turn outcomes; content attributes are ignored", () => {
  const facts = collectFacts([document([
    step("wrun_A", "turn_0", 0, { input: 3000, cached: 0, output: 20 }),
    span("chat mock", [str("gen_ai.conversation.id", "wrun_A"), str("ai.prompt.system", "SECRET PROMPT"), int("gen_ai.usage.input_tokens", 3000)]),
    tool("wrun_A", "bash"), tool("wrun_A", "read_file", true),
    span("invoke_agent arc-eve", [str("gen_ai.conversation.id", "wrun_A"), str("agent.turn.id", "turn_0"), str("agent.turn.outcome", "completed")]),
  ])]);
  assert.equal(facts.steps.length, 1);
  assert.equal(facts.steps[0].inputTokens, 3000);
  assert.deepEqual(facts.toolCalls.map((c) => [c.toolName, c.error]), [["bash", false], ["read_file", true]]);
  assert.equal(facts.turnOutcomes["wrun_A/turn_0"], "completed");
  assert.equal(JSON.stringify(facts).includes("SECRET"), false);
});

test("buildReport weights tokens by billing type per session and reports cost share", () => {
  const report = buildReport(collectFacts([document([
    step("wrun_A", "turn_0", 0, { input: 4000, cached: 0, output: 100 }, "openai/gpt-5-mini", "1"),
    step("wrun_A", "turn_0", 1, { input: 4200, cached: 4000, output: 50 }, "openai/gpt-5-mini", "2"),
    step("wrun_A", "turn_1", 0, { input: 4400, cached: 4096, output: 200 }, "openai/gpt-5-mini", "3"),
    tool("wrun_A", "arc_delegate"),
  ]), document([
    step("wrun_B", "turn_0", 0, { input: 3000, cached: 0, output: 10 }),
    tool("wrun_B", "bash"), tool("wrun_B", "bash", true),
  ])]));
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.totals.turns, 3);
  assert.equal(report.totals.steps, 4);
  const a = report.sessions.find((s) => s.conversationId === "wrun_A")!;
  assert.equal(a.inputTokens, 12600);
  assert.equal(a.cacheReadTokens, 8096);
  assert.equal(a.uncachedInputTokens, 4504);
  assert.equal(a.outputTokens, 350);
  assert.equal(a.firstStepInputTokens, 4000);
  assert.equal(a.turns, 2);
  const expected = (4504 * 0.25 + 8096 * 0.025 + 350 * 2) / 1_000_000;
  assert.ok(Math.abs((a.costUsd ?? 0) - expected) < 1e-6);
  assert.equal(report.totals.costUsd !== undefined, true);
  const share = report.totals.costShare!;
  assert.ok(Math.abs(share.uncachedInput + share.cachedInput + share.output - 1) < 0.001);
  assert.deepEqual(report.tools.map((t) => [t.toolName, t.calls, t.errors, t.sessionsUsing]), [["bash", 2, 1, 1], ["arc_delegate", 1, 0, 1]]);
  const text = formatReport(report);
  assert.match(text, /sessions 2 {2}turns 3 {2}model calls 4/);
  assert.match(text, /arc_delegate/);
});

test("unknown models are reported as unpriced instead of guessed", () => {
  const report = buildReport(collectFacts([document([step("wrun_C", "turn_0", 0, { input: 10, cached: 0, output: 1 }, "mock-gpt")])]));
  assert.equal(report.totals.costUsd, undefined);
  assert.equal(report.pricedModels["mock-gpt"], null);
  assert.match(formatReport(report), /unpriced models.*mock-gpt/);
});

test("priceFor matches bare ids, provider-qualified ids, and dated variants by longest prefix", () => {
  assert.equal(priceFor("openai/gpt-5-mini", DEFAULT_PRICES), DEFAULT_PRICES["gpt-5-mini"]);
  assert.equal(priceFor("gpt-5-mini-2026-03-01", DEFAULT_PRICES), DEFAULT_PRICES["gpt-5-mini"]);
  assert.equal(priceFor("gpt-5-2026-03-01", DEFAULT_PRICES), DEFAULT_PRICES["gpt-5"]);
  assert.equal(priceFor("gpt-5-minimax", DEFAULT_PRICES), null);
  assert.equal(stepCostUsd({ conversationId: "", turnId: "", stepIndex: 0, model: "", provider: "", inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 0, startedAt: "0" }, { input: 1, cachedInput: 0.1, output: 0 }), 0.1);
});

test("parseArgs accepts --price and env price overrides and rejects unknown flags", () => {
  const parsed = parseArgs(["--json", "--price=mock-gpt=1,0.1,4"], {}, "/repo")!;
  assert.equal(parsed.json, true);
  assert.equal(parsed.tracesDir, "/repo/.eve/traces/v1");
  assert.deepEqual(parsed.prices["mock-gpt"], { input: 1, cachedInput: 0.1, output: 4 });
  const fromEnv = parseArgs([], { EVE_PARENT_MODEL: "custom", EVE_PRICE_INPUT_PER_M: "2", EVE_PRICE_CACHED_PER_M: "0.2", EVE_PRICE_OUTPUT_PER_M: "8" }, "/repo")!;
  assert.deepEqual(fromEnv.prices.custom, { input: 2, cachedInput: 0.2, output: 8 });
  assert.equal(parseArgs(["--nope"]), undefined);
  assert.equal(parseArgs(["--price=bad"]), undefined);
});

test("runCli reads a trace store on disk and skips malformed segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "arc-eve-token-report-"));
  const segments = join(root, "trace-1", "segments");
  await mkdir(segments, { recursive: true });
  await writeFile(join(segments, "a.otlp.json"), JSON.stringify(document([step("wrun_D", "turn_0", 0, { input: 2048, cached: 1024, output: 30 }), tool("wrun_D", "ask_question")])));
  await writeFile(join(segments, "broken.otlp.json"), "{not json");
  assert.equal((await readTraceStore(root)).length, 1);
  let out = "";
  const code = await runCli([`--traces=${root}`, "--json"], { stdout: (t) => { out += t; }, stderr: () => {} });
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.cacheHitRate, 0.5);
  let err = "";
  assert.equal(await runCli([`--traces=${join(root, "missing")}`], { stdout: () => {}, stderr: (t) => { err += t; } }), 1);
  assert.match(err, /no trace segments/);
});

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Host-only token and cost report for the Eve parent.
 *
 * eve dev records one OTLP/JSON trace per turn under .eve/traces/v1 (the
 * store `eve traces` reads). Each `agent.step` span carries the provider
 * reported usage for one model call: agent.usage.input_tokens (which includes
 * the cached part), agent.usage.output_tokens, and
 * agent.usage.cache_read_tokens. This script folds those spans into a per
 * session (one operator task) and per tool ledger, weighted by billing type,
 * so a harness change can be judged by cost per task rather than per request.
 *
 * It is not an Eve tool. It reads span attributes only and prints counts,
 * model ids, tool names, and prices. Prompt or tool content that
 * EVE_TRACES_CONTENT=on may have captured is never read or printed.
 */

export interface StepUsage {
  conversationId: string;
  turnId: string;
  stepIndex: number;
  model: string;
  provider: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsdReported?: number;
  /** Span start in unix nanoseconds, kept as the OTLP string to avoid precision loss. */
  startedAt: string;
}

export interface ToolCall {
  conversationId: string;
  toolName: string;
  error: boolean;
}

export interface TraceFacts {
  steps: StepUsage[];
  toolCalls: ToolCall[];
  turnOutcomes: Record<string, "completed" | "failed" | "cancelled" | string>;
}

/** US dollars per one million tokens. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Published list prices at the time of writing. They are inputs to the
 * report, not facts the script can verify; override with --price or the
 * EVE_PRICE_* variables when they change or when another model is used.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
};

export interface SessionSummary {
  conversationId: string;
  turns: number;
  steps: number;
  models: string[];
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  firstStepInputTokens: number | undefined;
  toolCalls: number;
  toolErrors: number;
  costUsd: number | undefined;
  costUsdReported: number | undefined;
  cacheHitRate: number;
}

export interface ToolSummary {
  toolName: string;
  calls: number;
  errors: number;
  sessionsUsing: number;
}

export interface Report {
  sessions: SessionSummary[];
  tools: ToolSummary[];
  totals: {
    sessions: number;
    turns: number;
    steps: number;
    inputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costUsd: number | undefined;
    costShare: { uncachedInput: number; cachedInput: number; output: number } | undefined;
    perSession: { steps: number; turns: number; inputTokens: number; outputTokens: number; costUsd: number | undefined };
    cacheHitRate: number;
  };
  pricedModels: Record<string, ModelPrice | null>;
}

type OtlpAttribute = { key: string; value: Record<string, unknown> };
type OtlpSpan = { name: string; attributes?: OtlpAttribute[]; startTimeUnixNano?: string; status?: { code?: number } };

function attributeValue(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return value.boolValue;
  return undefined;
}

function attributes(span: OtlpSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of span.attributes ?? []) if (a && typeof a.key === "string") out[a.key] = attributeValue(a.value);
  return out;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Flatten every span of an OTLP/JSON export document. */
export function spansOf(document: unknown): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  const resourceSpans = (document as { resourceSpans?: unknown[] })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return spans;
  for (const rs of resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown[] })?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const list = (ss as { spans?: unknown[] })?.spans;
      if (!Array.isArray(list)) continue;
      for (const span of list) if (span && typeof span === "object" && typeof (span as OtlpSpan).name === "string") spans.push(span as OtlpSpan);
    }
  }
  return spans;
}

/** Extract usage facts from parsed OTLP documents; content attributes are ignored. */
export function collectFacts(documents: unknown[]): TraceFacts {
  const facts: TraceFacts = { steps: [], toolCalls: [], turnOutcomes: {} };
  for (const document of documents) {
    for (const span of spansOf(document)) {
      const a = attributes(span);
      const conversationId = text(a["gen_ai.conversation.id"], "unknown");
      if (span.name === "agent.step") {
        facts.steps.push({
          conversationId,
          turnId: text(a["agent.turn.id"], "unknown"),
          stepIndex: count(a["agent.step.index"]),
          model: text(a["agent.model.id"], "unknown"),
          provider: text(a["agent.model.provider"], "unknown"),
          inputTokens: count(a["agent.usage.input_tokens"]),
          cacheReadTokens: count(a["agent.usage.cache_read_tokens"]),
          outputTokens: count(a["agent.usage.output_tokens"]),
          ...(typeof a["agent.usage.cost_usd"] === "number" ? { costUsdReported: a["agent.usage.cost_usd"] as number } : {}),
          startedAt: typeof span.startTimeUnixNano === "string" ? span.startTimeUnixNano : "0",
        });
      } else if (span.name.startsWith("execute_tool")) {
        facts.toolCalls.push({ conversationId, toolName: text(a["gen_ai.tool.name"], "unknown"), error: a["error.type"] !== undefined || span.status?.code === 2 });
      } else if (span.name.startsWith("invoke_agent")) {
        const turnId = text(a["agent.turn.id"]);
        if (turnId) facts.turnOutcomes[`${conversationId}/${turnId}`] = text(a["agent.turn.outcome"], "unknown");
      }
    }
  }
  return facts;
}

/** Read every trace segment under a local trace store directory. */
export async function readTraceStore(dir: string): Promise<unknown[]> {
  const documents: unknown[] = [];
  let traceDirs: string[] = [];
  try { traceDirs = await readdir(dir); } catch { return documents; }
  for (const traceId of traceDirs.sort()) {
    const segmentsDir = join(dir, traceId, "segments");
    let files: string[] = [];
    try { files = await readdir(segmentsDir); } catch { continue; }
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try { documents.push(JSON.parse(await readFile(join(segmentsDir, file), "utf8"))); } catch { /* malformed segments are skipped, as eve traces does */ }
    }
  }
  return documents;
}

/** Match a model id such as openai/gpt-5-mini or mock-gpt to a price entry. */
export function priceFor(model: string, prices: Record<string, ModelPrice>): ModelPrice | null {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  if (prices[model]) return prices[model];
  if (prices[bare]) return prices[bare];
  // A dated snapshot such as gpt-5-mini-2026-03-01 prices as its base id. Any
  // other suffix is a different model and stays unpriced rather than guessed.
  const dated = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(bare);
  return dated && prices[dated[1]] ? prices[dated[1]] : null;
}

export function stepCostUsd(step: StepUsage, price: ModelPrice): number {
  const cached = Math.min(step.cacheReadTokens, step.inputTokens);
  const uncached = step.inputTokens - cached;
  return (uncached * price.input + cached * price.cachedInput + step.outputTokens * price.output) / 1_000_000;
}

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

export function buildReport(facts: TraceFacts, prices: Record<string, ModelPrice> = DEFAULT_PRICES): Report {
  const bySession = new Map<string, StepUsage[]>();
  for (const step of facts.steps) (bySession.get(step.conversationId) ?? bySession.set(step.conversationId, []).get(step.conversationId)!).push(step);
  const toolsBySession = new Map<string, ToolCall[]>();
  for (const call of facts.toolCalls) (toolsBySession.get(call.conversationId) ?? toolsBySession.set(call.conversationId, []).get(call.conversationId)!).push(call);
  for (const id of toolsBySession.keys()) if (!bySession.has(id)) bySession.set(id, []);

  const pricedModels: Record<string, ModelPrice | null> = {};
  const sessions: SessionSummary[] = [];
  let costShareUncached = 0, costShareCached = 0, costShareOutput = 0, anyUnpriced = false;

  for (const [conversationId, steps] of [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    steps.sort((a, b) => a.startedAt.length - b.startedAt.length || (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.stepIndex - b.stepIndex));
    const turns = new Set(steps.map((s) => s.turnId));
    const models = [...new Set(steps.map((s) => s.model))];
    let inputTokens = 0, cacheReadTokens = 0, outputTokens = 0, costUsd = 0, costUsdReported = 0, priced = true, reported = true;
    for (const step of steps) {
      const cached = Math.min(step.cacheReadTokens, step.inputTokens);
      inputTokens += step.inputTokens; cacheReadTokens += cached; outputTokens += step.outputTokens;
      if (step.costUsdReported === undefined) reported = false; else costUsdReported += step.costUsdReported;
      const price = priceFor(step.model, prices);
      pricedModels[step.model] = price;
      if (!price) { priced = false; continue; }
      costUsd += stepCostUsd(step, price);
      costShareUncached += ((step.inputTokens - cached) * price.input) / 1_000_000;
      costShareCached += (cached * price.cachedInput) / 1_000_000;
      costShareOutput += (step.outputTokens * price.output) / 1_000_000;
    }
    if (!priced) anyUnpriced = true;
    const calls = toolsBySession.get(conversationId) ?? [];
    const first = steps.find((s) => s.stepIndex === 0) ?? steps[0];
    sessions.push({
      conversationId,
      turns: turns.size,
      steps: steps.length,
      models,
      inputTokens,
      uncachedInputTokens: inputTokens - cacheReadTokens,
      cacheReadTokens,
      outputTokens,
      firstStepInputTokens: first?.inputTokens,
      toolCalls: calls.length,
      toolErrors: calls.filter((c) => c.error).length,
      costUsd: priced && steps.length > 0 ? round(costUsd, 6) : undefined,
      costUsdReported: reported && steps.length > 0 ? round(costUsdReported, 6) : undefined,
      cacheHitRate: inputTokens > 0 ? round(cacheReadTokens / inputTokens) : 0,
    });
  }

  const toolMap = new Map<string, ToolSummary & { sessions: Set<string> }>();
  for (const call of facts.toolCalls) {
    const entry = toolMap.get(call.toolName) ?? { toolName: call.toolName, calls: 0, errors: 0, sessionsUsing: 0, sessions: new Set<string>() };
    entry.calls++; if (call.error) entry.errors++; entry.sessions.add(call.conversationId);
    toolMap.set(call.toolName, entry);
  }
  const tools = [...toolMap.values()].map(({ sessions: s, ...rest }) => ({ ...rest, sessionsUsing: s.size })).sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));

  const sum = (pick: (s: SessionSummary) => number) => sessions.reduce((n, s) => n + pick(s), 0);
  const inputTokens = sum((s) => s.inputTokens), cacheReadTokens = sum((s) => s.cacheReadTokens), outputTokens = sum((s) => s.outputTokens);
  const steps = sum((s) => s.steps), turns = sum((s) => s.turns);
  const costUsd = anyUnpriced || sessions.length === 0 ? undefined : round(sum((s) => s.costUsd ?? 0), 6);
  const costTotal = costShareUncached + costShareCached + costShareOutput;
  const n = Math.max(sessions.length, 1);
  return {
    sessions,
    tools,
    totals: {
      sessions: sessions.length,
      turns,
      steps,
      inputTokens,
      uncachedInputTokens: inputTokens - cacheReadTokens,
      cacheReadTokens,
      outputTokens,
      costUsd,
      costShare: costUsd !== undefined && costTotal > 0 ? { uncachedInput: round(costShareUncached / costTotal), cachedInput: round(costShareCached / costTotal), output: round(costShareOutput / costTotal) } : undefined,
      perSession: { steps: round(steps / n, 2), turns: round(turns / n, 2), inputTokens: Math.round(inputTokens / n), outputTokens: Math.round(outputTokens / n), costUsd: costUsd === undefined ? undefined : round(costUsd / n, 6) },
      cacheHitRate: inputTokens > 0 ? round(cacheReadTokens / inputTokens) : 0,
    },
    pricedModels,
  };
}

const money = (v: number | undefined) => (v === undefined ? "n/a" : `$${v.toFixed(v < 0.01 ? 6 : 4)}`);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(`sessions ${t.sessions}  turns ${t.turns}  model calls ${t.steps}`);
  lines.push(`tokens: input ${t.inputTokens} (uncached ${t.uncachedInputTokens}, cached ${t.cacheReadTokens})  output ${t.outputTokens}  cache hit ${pct(t.cacheHitRate)}`);
  lines.push(`cost: total ${money(t.costUsd)}  per session ${money(t.perSession.costUsd)}  per session calls ${t.perSession.steps}`);
  if (t.costShare) lines.push(`cost share: uncached input ${pct(t.costShare.uncachedInput)}  cached input ${pct(t.costShare.cachedInput)}  output ${pct(t.costShare.output)}`);
  const unpriced = Object.entries(report.pricedModels).filter(([, p]) => p === null).map(([m]) => m);
  if (unpriced.length) lines.push(`unpriced models (pass --price=<model>=<input>,<cached>,<output> per million): ${unpriced.join(", ")}`);
  lines.push("");
  lines.push("session                              turns calls    input uncached   cached   output  first  tools errs  cost");
  for (const s of report.sessions) {
    lines.push(`${s.conversationId.padEnd(36).slice(0, 36)} ${String(s.turns).padStart(5)} ${String(s.steps).padStart(5)} ${String(s.inputTokens).padStart(8)} ${String(s.uncachedInputTokens).padStart(8)} ${String(s.cacheReadTokens).padStart(8)} ${String(s.outputTokens).padStart(8)} ${String(s.firstStepInputTokens ?? "-").padStart(6)} ${String(s.toolCalls).padStart(6)} ${String(s.toolErrors).padStart(4)}  ${money(s.costUsd)}`);
  }
  if (report.tools.length) {
    lines.push("");
    lines.push("tool                 calls  errors  sessions using");
    for (const tool of report.tools) lines.push(`${tool.toolName.padEnd(20)} ${String(tool.calls).padStart(5)} ${String(tool.errors).padStart(7)}  ${tool.sessionsUsing}/${report.totals.sessions} (${pct(tool.sessionsUsing / Math.max(report.totals.sessions, 1))})`);
  }
  return `${lines.join("\n")}\n`;
}

export interface ReportArgs { tracesDir: string; json: boolean; prices: Record<string, ModelPrice> }

/** --traces=<dir> --json --price=<model>=<input>,<cached>,<output>; EVE_PRICE_<INPUT|CACHED|OUTPUT>_PER_M set the default model row. */
export function parseArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ReportArgs | undefined {
  const rest = [...args];
  while (rest[0] === "--") rest.shift();
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  let tracesDir = resolve(cwd, ".eve", "traces", "v1");
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") { json = true; continue; }
    if (arg.startsWith("--traces=")) { const v = arg.slice(9); if (!v) return undefined; tracesDir = resolve(cwd, v); continue; }
    if (arg.startsWith("--price=")) {
      const m = /^--price=([^=]+)=([0-9.]+),([0-9.]+),([0-9.]+)$/.exec(arg);
      if (!m) return undefined;
      prices[m[1]] = { input: Number(m[2]), cachedInput: Number(m[3]), output: Number(m[4]) };
      continue;
    }
    return undefined;
  }
  const envPrice = ["EVE_PRICE_INPUT_PER_M", "EVE_PRICE_CACHED_PER_M", "EVE_PRICE_OUTPUT_PER_M"].map((k) => env[k]);
  if (envPrice.every((v) => typeof v === "string" && /^[0-9.]+$/.test(v))) {
    const model = env.EVE_PARENT_MODEL?.trim() || "gpt-5-mini";
    prices[model] = { input: Number(envPrice[0]), cachedInput: Number(envPrice[1]), output: Number(envPrice[2]) };
  }
  return { tracesDir, json, prices };
}

export async function runCli(args: readonly string[], options: { stdout?: (t: string) => void; stderr?: (t: string) => void; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<number> {
  const stdout = options.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = options.stderr ?? ((t: string) => process.stderr.write(t));
  const parsed = parseArgs(args, options.env ?? process.env, options.cwd ?? process.cwd());
  if (!parsed) { stderr("token-report: usage: token-report [--traces=<dir>] [--json] [--price=<model>=<input>,<cached>,<output>]\n"); return 2; }
  const documents = await readTraceStore(parsed.tracesDir);
  if (documents.length === 0) { stderr(`token-report: no trace segments under ${parsed.tracesDir} (run eve dev with EVE_TRACES=on, the default)\n`); return 1; }
  const report = buildReport(collectFacts(documents), parsed.prices);
  stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

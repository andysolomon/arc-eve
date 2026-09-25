# Eve parent token efficiency

Objective: lower the price-weighted token cost per completed operator task
without a measurable drop in task quality. This note records the harness map,
the measured baseline, the ranked opportunities, the changes that landed
(direct or behind flags), the test plan for the flagged ones, the proposals
that need an operator decision, and the gaps.

Nothing here changes `arc_delegate`'s contract, the `always()` approval gate,
the runner, or the worker plane.

## 1. Harness map

The parent is an Eve 0.54.3 app. Eve owns request assembly; this repo authors
the pieces Eve composes.

| Concern | Where | What happens |
| --- | --- | --- |
| System prompt | `agent/instructions.ts` → `agent/lib/parent-instructions.ts`; eve `runtime/prompt/compose.js` | Eve emits `Instructions (instructions)\n<text>`, then a fixed "Tool execution" block (55 tokens) whenever tools exist, then an "Agent messaging" block (191 tokens) only when a subagent tool is advertised, then connection and skill blocks (none here). No date, session id, cwd, or other volatile value reaches the prompt. |
| Tools | `agent/tools/*.ts` plus eve defaults (`framework/sources/registry.js`) | Deterministic order: framework defaults, then authored slots, then provider tools. Serialized with the AI SDK; the OpenAI chat provider sends `strict` JSON schemas. |
| Model call | eve `harness/tool-loop.js` | One model call per step, AI SDK `ToolLoopAgent.stream`, eve drives the loop. `agent/lib/parent-agent-model.ts` chooses gateway string model or direct `createOpenAI().chat()`. |
| Cache | eve `harness/prompt-cache.js`, `harness/step-hooks.js` | Gateway models get `gateway.caching: "auto"`. Direct Anthropic gets explicit `cacheControl` breakpoints. Direct OpenAI got nothing before this change; OpenAI caches ≥1024-token prefixes automatically. `safety_identifier` is a request field, not prompt content. |
| Reasoning | eve `harness/tool-loop.js`; compiled `@ai-sdk/openai` chat converter | Response messages are stored unchanged, but the chat-completions wire format has no reasoning parts, so reasoning does not round-trip across steps on the `.chat()` path. |
| Tool results | eve `execution/sandbox/*.js`; `agent/lib/arc-runtime.ts` | `bash` and `read_file` are capped at 2000 lines / 50 KB and tail-truncated. `read_file` prefixes every line with `n: `. `arc_delegate` returns a bounded, redacted JSON result (summary ≤2000 chars, four lists ≤20×500 chars). |
| Compaction | eve `harness/compaction.js`, `compaction-prompt.js` | Triggers at 90% of the context window (400k for gateway gpt-5-mini, 128k default for direct routing). First shortens old tool results heuristically (>2000 chars → 2000-char stub), then summarizes with a ~120-token system prompt. History before the summary is replaced; stream events stay in `.eve/.workflow-data`. |
| Subagents | eve default `agent` tool | Copies the root agent into a background task. Disabled here (issue #6: the worker plane is external). |
| Telemetry | eve local traces `.eve/traces/v1`; `scripts/token-report.ts` | Every `agent.step` span carries `agent.usage.input_tokens` (cached included), `agent.usage.output_tokens`, `agent.usage.cache_read_tokens`, model id, turn id. Reasoning tokens are not recorded. Gateway calls add cost. |

## 2. Baseline

Method: the parent was pointed at a local mock OpenAI-compatible server through
direct routing (`EVE_PARENT_BASE_URL`), which logs every request body and
returns a fixed five-step script (bash, read_file, text, arc_delegate, text)
over three operator turns, with the arc_delegate call approved through
`eve invoke --resume`. Tokens were counted with the `o200k_base` tokenizer on
the rendered request, and the same run was read back with
`pnpm token-report`. The rendered request, not the templates, is what was read.

Static prefix of the first request, before any change:

| Source | Tokens | Share of prefix |
| --- | ---: | ---: |
| Authored instructions | 251 | 8% |
| eve "Tool execution" block | 55 | 2% |
| eve "Agent messaging" block (only because `agent` tool existed) | 191 | 6% |
| `arc_delegate` (authored) | 447 | 15% |
| `read_file` | 342 | 11% |
| `todo` | 341 | 11% |
| `agent` (subagent) | 320 | 11% |
| `web_fetch` | 282 | 9% |
| `ask_question` | 232 | 8% |
| `write_file` | 224 | 7% |
| `load_skill` (zero skills declared) | 121 | 4% |
| `task_cancel` | 120 | 4% |
| `bash` | 73 | 2% |
| **Static prefix** | **2999** | 100% |

The first user message was 24 tokens. Each later step adds 30–150 tokens of
conversation. On a three-turn task the static prefix was 92% of every
request's input.

Whole scripted task at gpt-5-mini list prices ($0.25 / $0.025 / $2.00 per
million input, cached input, output):

| Billing type | Tokens | Cost share |
| --- | ---: | ---: |
| Uncached input | 3926 | 45% |
| Cached input | 12416 | 14% |
| Output (fixed by the script) | 439 | 41% |

Cost per scripted task: $0.00217. Cache hit rate 76% (OpenAI-style 128-token
granularity simulated by the mock). Real output share will be higher because
gpt-5-mini reasons at medium effort by default and the mock's output is fixed.

Tool facts from the same run: `read_file` erred (file not found), `bash`
listed an empty `/workspace`. The just-bash sandbox is a virtual filesystem
under `.eve/sandbox-cache/`, never the host checkout, so every parent-local
file exploration is a wasted step.

Turns per task: 3 operator turns, 5 model calls, 3 tool calls, 1 tool error.

## 3. Ranked opportunities

Ranked by share of spend × fraction removable ÷ quality risk. Savings are on
the static prefix unless stated, measured on the rendered request.

| # | Layer | Change | Savings | How estimated | Risk | Validate | Roll back | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Tools + prompt | Disable `agent`, `task_cancel`, `load_skill` | −752 prefix tokens (−25%); scripted task cost −12.8% | Rendered request before/after | None to quality: the tools contradict issue #6 or cannot succeed | `pnpm test`, `eve info` shows 8 tools | Delete the three slot files | Shipped |
| 2 | Tools | Lean tool set (drop `web_fetch`, `web_search`, `todo`, `write_file`; short `read_file` description) | −996 prefix tokens more (−44% of remaining); scripted task cost −29.3% vs baseline with #1 and #3 | Rendered request | Low: sandbox is empty so `write_file` cannot help; `todo` adds steps on one-call tasks; web tools belong to the worker | A/B on real tasks (section 6) | `EVE_PARENT_LEAN_TOOLS` unset | Flagged, off |
| 3 | Prompt | Lean instructions | −38 prefix tokens, plus fewer wasted exploration steps expected | Rendered request; transcript showed sandbox exploration | Medium: prompt edits change behavior | A/B on real tasks | `EVE_PARENT_LEAN_INSTRUCTIONS` unset | Flagged, off |
| 4 | Cache | `prompt_cache_key` for OpenAI | Cache-hit rate on the ~1.2–2.2k prefix; each hit is 10× cheaper input | OpenAI routing semantics; cannot be measured against the mock | Low: only sent to api.openai.com or gateway openai | Compare `cacheHitRate` in `pnpm token-report` before/after | `EVE_PARENT_PROMPT_CACHE_KEY=off` | Shipped |
| 5 | Cache | 24h prompt-cache retention | Turns hits into cache reads when an operator returns after minutes | OpenAI extended retention | Medium: unsupported models reject the field | One real turn, then `token-report` | Flag unset | Flagged, off |
| 6 | Telemetry | Per-task ledger by billing type | Enables every measurement above | n/a | None | `pnpm test` | Remove script | Shipped |
| 7 | Model | Reasoning effort `low` for the parent | Output is 41%+ of cost; reasoning tokens dominate output | Price table | Medium: contract quality | Offline task set with judge | `reasoning` field | Proposal |
| 8 | Model | Responses API for direct OpenAI so reasoning items round-trip | Fewer re-derivations across steps | Vendor guidance | Medium: `.chat()` chosen for OpenAI-compatible endpoints | Real tasks, steps per task | Keep `.chat()` | Proposal |
| 9 | Tools | Shorter `arc_delegate` description, schema field descriptions | ±50 tokens; may cut validation-error retries | Rendered request | Medium: contract tool | Tool error rate in `token-report` | Revert | Proposal |
| 10 | Results | Spill large `bash` output to a sandbox file | Only matters once a real sandbox (Docker) replaces just-bash | eve caps at 50 KB | Low | n/a now | n/a | Deferred |

Not worth doing now: compaction tuning (threshold at 360k tokens is never
reached by a delegation task), sparse `read_file` line numbers (the sandbox
holds no files), moving volatile content out of the prefix (there is none),
tool-order determinism (already deterministic).

## 4. Changes made

Each landed in its own commit on this branch.

1. **`pnpm token-report`** (`scripts/token-report.ts`). Reads `.eve/traces/v1`
   and prints per session (one task) and total: input split into uncached and
   cached, output, cache-hit rate, first-step input (the prefix), model calls
   and turns per task, tool calls and errors per tool with the share of
   sessions using each tool, and cost under a price table. `--price` and
   `EVE_PRICE_*` override prices; `--json` for machines. Usage attributes
   only; captured content is never read.
2. **Disabled `agent`, `task_cancel`, `load_skill`** (`agent/tools/*.ts`
   exporting `disableTool()`). Removes the "Agent messaging" system block too.
3. **Flagged lean tool set** (`EVE_PARENT_LEAN_TOOLS`, `agent/lib/tool-slots.ts`).
4. **Flagged lean instructions** (`EVE_PARENT_LEAN_INSTRUCTIONS`,
   `agent/lib/parent-instructions.ts`). `agent/instructions.md` became
   `agent/instructions.ts` so the variant can be selected; the full text is
   unchanged.
5. **OpenAI `prompt_cache_key`** default on for the openai endpoint;
   `EVE_PARENT_PROMPT_CACHE_RETENTION=24h` opt-in
   (`agent/lib/parent-agent-model.ts`).

Flags are read from `process.env` then `.env.local`
(`agent/lib/harness-flags.ts`). Slots and instructions compile when `eve dev`
starts, so restart it after toggling a flag.

### System prompt diff (lean variant)

Original sentence → decision and reason.

| Original | Decision | Reason |
| --- | --- | --- |
| "You are the ARC Eve parent." | Keep | Identity. |
| "Use arc_delegate only for an operator-approved request." | Rewrite | Approval is enforced by `always()`; the fact the model needs is that every call pauses for approval. |
| "Its exact bounded contract is outcome, scope, verification, preserved_behavior, prohibitions, and label, plus supplied optional context, decision_refs, and assumption_refs;" | Delete | Duplicates the tool schema's required and optional fields. |
| "automatic Implement also requires exactly one canonical workload class and implement_authorized=true metadata." | Keep (compacted) | Cross-field rule the schema cannot express; a miss costs a validation error and a retry step. |
| "Explore, Research, and Plan pause before any runner spawn." | Delete | Subset of "every call pauses". |
| "Human Eve approval (`always()`) is authoritative and precedes spawn: authorization metadata is compatibility metadata for routing, never sufficient authorization and never something the model can self-authorize." | Rewrite | Kept as "set implement_authorized or deploy_authorized only when the operator states that authorization; they are routing metadata, not approval". |
| "Deploy is a separate, synchronous-only, always-gated path requiring deploy_authorized=true metadata; background Deploy is rejected." | Rewrite | Kept as "Deploy needs deploy_authorized=true and runs synchronously". `background` is rejected for every phase; the field is simply left unset. |
| "Declines, cancellation, and calls that do not receive approval launch nothing." | Rewrite | Kept as environment knowledge for reporting: "a declined or cancelled call launched nothing; report that instead of retrying". |
| "Eve 0.54.3 exposes the static `always()` policy used here; authored code and tests can verify that declaration and fail-closed validation, but cannot simulate the Eve approval UI." | Delete | Developer note, not model-facing. |
| "Do not add Decision Ledger parity or replace arc_ask_operator." | Delete | Instruction to contributors; the model cannot add tools. |
| "Workloads run against the supplied real host checkout, not Eve's sandbox." | Keep + add | Added the fact transcripts showed missing: sandbox tools see an empty virtual filesystem, and `ask_question` is the way to get a missing checkout path or outcome. |
| "Never expose credentials, raw runner output, prompts, or transcripts." | Keep | Product rule for the model's own summaries. |
| "The external arc-orchestrator and runner-routing-v4 remain the worker plane." | Rewrite | Folded into the identity sentence as "the external ARC runner (arc-orchestrator with runner-routing-v4)". |
| (new) "You turn each request into one arc_delegate call and report its result." / "Report the returned summary, changes, verification, risks, and next actions." | Add | Shape of the task; replaces nothing the model could infer. |

No sentence was moved to a user-role setup message: eve puts nothing
per-session in the system prompt, so there was nothing volatile to move.

## 5. Measured effect

Same scripted five-step task, gpt-5-mini list prices, mock cache at 128-token
granularity. Output tokens are fixed by the script and identical in every row.

| Configuration | Prefix tokens | Prompt tokens (task) | Uncached | Cached | Cost | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 2999 | 16342 | 3926 | 12416 | $0.00217 | — |
| Shipped (subagent tools off, cache key) | 2247 | 12583 | 3111 | 9472 | $0.00189 | −12.8% |
| Shipped + both lean flags | 1213 | 7460 | 2084 | 5376 | $0.00153 | −29.3% |

These are prefix-only savings on a fixed script. They do not include the
steps the lean instructions are meant to remove (parent-local file
exploration), and they do not include reasoning output, which real runs will
add to every row equally unless reasoning effort changes.

## 6. Test plan for the flagged changes

Quality has not been measured with a real model in this change; the flags stay
off until it is.

1. **Task set.** Ten to twenty real operator requests phrased as operators
   write them, drawn from `session-runs` labels and the e2e acceptance run:
   an Explore with a stated checkout, an Explore with the path missing, a
   Plan, an Implement with a workload class, an Implement missing
   `implement_authorized`, a Deploy, a request the parent should refuse, a
   two-turn follow-up.
2. **Runs.** For each of the four configurations (flags off; lean tools; lean
   instructions; both), run the set against the fake runner
   (`pnpm e2e-acceptance --run --mode=fake` style checkout) with the real
   parent model, approving through `eve dev` or `eve invoke --resume`.
3. **Metrics from `pnpm token-report`.** Cost per session, model calls per
   session, tool calls and errors per tool, cache-hit rate, first-step input.
4. **Quality guardrails.** Per task: did the approved `arc_delegate` contract
   carry the operator's outcome and scope; did the parent ask when the
   checkout was missing instead of exploring; did it set authorization flags
   only when stated; did the final reply report status, risks and next
   actions without raw output. Score with a rubric or `eve eval` judge
   assertions; `evals/` can host these as `defineEval` cases.
5. **Ship rule.** Enable a flag by default only when cost per completed task
   drops and no guardrail regresses beyond run-to-run noise (run each
   configuration twice). Record null results here.
6. **Online.** Once flags default on, watch `token-report` weekly on real
   sessions: cost per session, steps per session, `ask_question` share,
   `arc_delegate` error rate.

For `EVE_PARENT_PROMPT_CACHE_RETENTION=24h`: one real gateway turn with the
flag on; a 400 from the provider means the model does not support it.

## 7. Proposals (operator decision)

- **Reasoning effort.** gpt-5-mini defaults to medium. The parent's job is
  contract composition and reporting; `reasoning: "low"` in `agent.ts` is
  likely enough and cuts the largest billing type. Test with the task set
  above before changing.
- **Responses API for direct OpenAI.** `.chat()` was chosen so any
  OpenAI-compatible endpoint works. For `api.openai.com` specifically the
  Responses API carries reasoning items across steps; without them the model
  re-derives its plan each step. Route by hostname if adopted.
- **`arc_delegate` description.** Shorten to the behaviors the schema cannot
  express and add one-line descriptions to `phase`, `workload_class`, and the
  authorization flags. Measure by the tool's error rate.
- **Sandbox.** Once a Docker sandbox with the checkout mounted replaces
  just-bash, revisit sparse `read_file` numbering and spilling large `bash`
  output to files; both are moot on an empty virtual filesystem.

## 8. Gaps

- No real-model runs: the sandbox has no provider credential or runner, so
  quality was not measured. All token numbers come from rendered requests
  against a mock provider with a fixed script.
- Reasoning tokens are not in eve's traces; `token-report` counts them inside
  output. Gateway cost per step is recorded only when the AI Gateway serves
  the call.
- No historical traces existed in the repo, so there is no real turns-per-task
  or tool-usage distribution. The share-of-runs-using-each-tool column will
  fill in once operators run with traces on (the default).
- OpenAI cache behavior (hit rate, effect of `prompt_cache_key`) can only be
  measured on real calls; the mock simulates prefix caching.
- Prices are the published list prices at the time of writing and are inputs
  to the report, not verified facts.

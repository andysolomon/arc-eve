# Eve parent provider

The Eve parent model is selected at host startup. `agent/agent.ts` resolves a
provider-qualified model string and passes it to `defineAgent({ model })`; no
worker route, `arc_delegate` contract, or generated Eve surface is changed.

## First run

1. Install dependencies with `pnpm install`.
2. Copy `.env.example` to `.env.local` and replace the safe placeholders with
   the operator's chosen parent settings.
3. Run `pnpm parent-provider -- check`. The command exits non-zero with generic
   guidance when no parent credential is present.
4. Restart `eve dev` after changing `.env.local`; the model is selected when
   `agent/agent.ts` is loaded.

The built-in model is `openai/gpt-5-mini`. Eve string models use the AI Gateway,
so `AI_GATEWAY_API_KEY` (or the linked Vercel OIDC environment) is accepted as
a compatibility credential. For an API-key-backed model turn, set that gateway
variable in `.env.local` alongside the canonical ARC-facing
`EVE_PARENT_API_KEY`; the resolver only checks presence and never copies one
credential variable into another or into an ARC-owned store. A real model turn
still requires a valid credential accepted by Eve's selected provider.

## Configuration precedence

For each setting, the resolver checks `process.env`, then `.env.local`, then
the built-in default. Within either source, the canonical `EVE_PARENT_*`
variable wins over compatibility aliases. Empty or malformed dotenv entries are
ignored, and malformed `.env.local` lines do not prevent the default model from
loading.

| Canonical setting | Compatibility aliases |
| --- | --- |
| `EVE_PARENT_PROVIDER` | `ARC_ORCHESTRATOR_PARENT_PROVIDER`, `ARC_ORCHESTRATOR_PROVIDER`, `ARC_PI_PROVIDER`, `EVE_PROVIDER`, `PARENT_PROVIDER` |
| `EVE_PARENT_MODEL` | `ARC_ORCHESTRATOR_PARENT_MODEL`, `ARC_ORCHESTRATOR_MODEL`, `ARC_PI_MODEL`, `EVE_MODEL`, `PARENT_MODEL` |
| `EVE_PARENT_BASE_URL` | `ARC_ORCHESTRATOR_PARENT_BASE_URL`, `ARC_ORCHESTRATOR_BASE_URL`, `ARC_PI_BASE_URL`, `EVE_BASE_URL`, `PARENT_BASE_URL` |
| `EVE_PARENT_API_KEY` | `ARC_ORCHESTRATOR_PARENT_API_KEY`, `ARC_ORCHESTRATOR_API_KEY`, `ARC_PI_API_KEY`, `EVE_API_KEY`, `PARENT_API_KEY`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN` |

## Direct routing (non-gateway providers)

Leave `EVE_PARENT_BASE_URL` blank for AI Gateway routing: Eve receives the
qualified string model and resolves its own model metadata.

Set `EVE_PARENT_BASE_URL` to an OpenAI-compatible base URL (for example
`https://api.minimax.io/v1`) to route the parent model directly, bypassing the
gateway. Direct routing:

- calls the provider's chat-completions endpoint (`<base>/chat/completions`)
  with the bare model id after the first slash;
- sends the credential from `EVE_PARENT_API_KEY`;
- requires a context window, because Eve compiles its compaction trigger from
  one and cannot fall back to AI Gateway catalog metadata for a provider the
  gateway does not list. `EVE_PARENT_MODEL_CONTEXT_WINDOW_TOKENS` overrides
  the conservative 128000-token default; a malformed value falls back to the
default rather than failing startup.

No parent credential is imported into ARC worker processes, and `.env.local` is
bootstrapped into `process.env` at agent module load (real process environment
always wins).

## Redaction and operator boundary

`pnpm parent-provider -- status` and `pnpm parent-provider -- check` emit only
bounded JSON containing the selected provider, selected model, and the generic
credential state `configured` or `missing`. They never print API keys, base URLs,
account identifiers, provider output, prompts, or transcripts. Missing
credentials produce a short actionable message without raw diagnostics; `check`
returns exit code 1 until a non-empty credential value is present.

This is a host-only operator CLI. It is not registered under `agent/tools/`, is
not an Eve-authored/model-callable tool, does not launch a browser, and does not
write authentication state.

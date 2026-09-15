import { createOpenAI } from "../node_modules/eve/dist/src/compiled/@ai-sdk/openai/index.js";
import { defineAgent } from "eve";
import { parentAgentDefinition } from "./lib/parent-agent-model.js";
import { loadDotEnvIntoProcessEnv, resolveParentProvider } from "./lib/parent-provider.js";

// Bootstrap .env.local into process.env once at module load. Process env
// always wins; .env.local is the fallback. This is what lets the real
// EVE_PARENT_API_KEY / AI_GATEWAY_API_KEY reach downstream code (eve's
// gateway model call, the createOpenAI factory invoked below, etc.).
loadDotEnvIntoProcessEnv();

const parentProvider = resolveParentProvider();

// Direct routing (EVE_PARENT_BASE_URL set) carries an explicit
// modelContextWindowTokens so eve can compile its compaction trigger without
// an AI Gateway catalog lookup it cannot satisfy for non-gateway providers.
export default defineAgent(parentAgentDefinition(parentProvider, createOpenAI));

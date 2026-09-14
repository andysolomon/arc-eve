import { createOpenAI } from "../node_modules/eve/dist/src/compiled/@ai-sdk/openai/index.js";
import { defineAgent } from "eve";
import { parentAgentModel } from "./lib/parent-agent-model.js";
import { resolveParentProvider } from "./lib/parent-provider.js";

const parentProvider = resolveParentProvider();

export default defineAgent({
  model: parentAgentModel(parentProvider, createOpenAI),
});

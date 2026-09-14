import { defineAgent } from "eve";
import { resolveParentProvider } from "./lib/parent-provider.js";

const parentProvider = resolveParentProvider();

export default defineAgent({
  model: parentProvider.model,
});

import { defineInstructions } from "eve/instructions";
import { harnessFlags } from "./lib/harness-flags.js";
import { parentInstructions } from "./lib/parent-instructions.js";

// Static system instructions, resolved once at compile time. The text lives
// in agent/lib/parent-instructions.ts; EVE_PARENT_LEAN_INSTRUCTIONS selects
// the shorter variant.
export default defineInstructions({ content: parentInstructions(harnessFlags) });

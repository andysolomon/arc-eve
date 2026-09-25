import definition from "eve/tools/web_fetch";
import { harnessFlags } from "../lib/harness-flags.js";
import { selectDefaultTool } from "../lib/tool-slots.js";

// Framework default, removed from the model-facing surface when
// EVE_PARENT_LEAN_TOOLS is on (see agent/lib/tool-slots.ts).
export default selectDefaultTool(harnessFlags, "web_fetch", definition);

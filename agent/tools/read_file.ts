import { readFile } from "eve/tools/read_file";
import { harnessFlags } from "../lib/harness-flags.js";
import { selectReadFile } from "../lib/tool-slots.js";

// Framework executor unchanged; EVE_PARENT_LEAN_TOOLS swaps in a shorter
// description (see agent/lib/tool-slots.ts).
export default selectReadFile(harnessFlags, readFile);

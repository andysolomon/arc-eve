import { disableTool } from "eve/tools";

// eve advertises load_skill even when the agent declares no skills, and this
// agent has none, so the tool can only fail. Delete this file when the first
// skill lands under agent/skills/.
export default disableTool();

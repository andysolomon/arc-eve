import { disableTool } from "eve/tools";

// The Eve parent never spawns Eve subagents: arc-orchestrator and
// runner-routing-v4 are the worker plane (README, issue #6), and arc_delegate
// is the only delegation path. Disabling the default root `agent` tool also
// removes eve's "Agent messaging" system-prompt block, which exists only when
// a subagent tool is advertised. Delete this file to restore the framework tool.
export default disableTool();

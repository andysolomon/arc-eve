import { disableTool } from "eve/tools";

// task_cancel only acts on background tasks started by the `agent` subagent
// tool, which this parent disables. arc_delegate rejects background execution,
// so there is never a task for the model to cancel.
export default disableTool();

import test from "node:test";
import assert from "node:assert/strict";
import { isDisabledToolSentinel } from "eve/tools";
import agentSlot from "../agent/tools/agent.ts";
import taskCancelSlot from "../agent/tools/task_cancel.ts";
import loadSkillSlot from "../agent/tools/load_skill.ts";

test("subagent, task_cancel, and load_skill default tools are disabled for the parent", () => {
  for (const [name, slot] of [["agent", agentSlot], ["task_cancel", taskCancelSlot], ["load_skill", loadSkillSlot]] as const) {
    assert.equal(isDisabledToolSentinel(slot), true, `${name} slot should export disableTool()`);
  }
});

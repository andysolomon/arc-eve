import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";
import { readFile } from "eve/tools/read_file";
import { resolveHarnessFlags } from "../agent/lib/harness-flags.js";
import { FULL_PARENT_INSTRUCTIONS, LEAN_PARENT_INSTRUCTIONS, parentInstructions } from "../agent/lib/parent-instructions.js";
import { LEAN_READ_FILE_DESCRIPTION, selectDefaultTool, selectReadFile } from "../agent/lib/tool-slots.js";

const isolatedCwd = "/path/that/does/not/exist";

test("flags default to the baseline behavior and accept on/off spellings from env then .env.local", async () => {
  const defaults = resolveHarnessFlags({}, isolatedCwd);
  assert.deepEqual(defaults, { leanTools: false, leanInstructions: false, promptCacheKey: true, promptCacheRetention: undefined });

  const on = resolveHarnessFlags({ EVE_PARENT_LEAN_TOOLS: "1", EVE_PARENT_LEAN_INSTRUCTIONS: "true", EVE_PARENT_PROMPT_CACHE_KEY: "off", EVE_PARENT_PROMPT_CACHE_RETENTION: "24h" }, isolatedCwd);
  assert.deepEqual(on, { leanTools: true, leanInstructions: true, promptCacheKey: false, promptCacheRetention: "24h" });

  assert.equal(resolveHarnessFlags({ EVE_PARENT_LEAN_TOOLS: "maybe" }, isolatedCwd).leanTools, false);
  assert.equal(resolveHarnessFlags({ EVE_PARENT_PROMPT_CACHE_RETENTION: "1h" }, isolatedCwd).promptCacheRetention, undefined);

  const cwd = await mkdtemp(join(tmpdir(), "arc-eve-harness-flags-"));
  await writeFile(join(cwd, ".env.local"), "EVE_PARENT_LEAN_TOOLS=1\nEVE_PARENT_LEAN_INSTRUCTIONS=1\n");
  assert.equal(resolveHarnessFlags({}, cwd).leanTools, true);
  assert.equal(resolveHarnessFlags({ EVE_PARENT_LEAN_INSTRUCTIONS: "0" }, cwd).leanInstructions, false, "process env wins over .env.local");
});

test("instructions variant follows the lean flag", () => {
  assert.equal(parentInstructions({ leanInstructions: false }), FULL_PARENT_INSTRUCTIONS);
  assert.equal(parentInstructions({ leanInstructions: true }), LEAN_PARENT_INSTRUCTIONS);
});

test("lean tool selection disables only the listed defaults and shortens read_file", () => {
  const definition = { description: "x" };
  assert.equal(selectDefaultTool({ leanTools: false }, "todo", definition), definition);
  assert.equal(isDisabledToolSentinel(selectDefaultTool({ leanTools: true }, "todo", definition)), true);
  assert.equal(selectReadFile({ leanTools: false }, readFile), readFile);
  const lean = selectReadFile({ leanTools: true }, readFile);
  assert.equal(lean.description, LEAN_READ_FILE_DESCRIPTION);
  assert.equal(lean.execute, readFile.execute, "executor is the framework one");
  assert.equal(lean.inputSchema, readFile.inputSchema);
});

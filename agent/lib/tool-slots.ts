import { defineTool, disableTool, type DisabledToolSentinel, type ToolDefinition } from "eve/tools";
import type { HarnessFlags } from "./harness-flags.js";

/**
 * Framework default tools that leave the model-facing surface when
 * EVE_PARENT_LEAN_TOOLS is on. Each is either unusable from the parent's
 * empty just-bash sandbox (write_file), reserved for the worker plane
 * (web_fetch, web_search), or a checklist tool that costs a step on every
 * short request (todo).
 */
export const LEAN_DISABLED_TOOLS = ["web_fetch", "web_search", "todo", "write_file"] as const;
export type LeanDisabledTool = (typeof LEAN_DISABLED_TOOLS)[number];

/** Keep the framework definition unless the lean flag removes this slot. */
export function selectDefaultTool<T>(flags: Pick<HarnessFlags, "leanTools">, name: LeanDisabledTool, definition: T): T | DisabledToolSentinel {
  return flags.leanTools && LEAN_DISABLED_TOOLS.includes(name) ? disableTool() : definition;
}

export const LEAN_READ_FILE_DESCRIPTION =
  "Read a text file from the sandbox filesystem. filePath is absolute (or starts with $HOME/). Returns lines as `<line>: <content>`, 2000 lines per call; pass offset (1-based) to continue.";

/**
 * The framework read_file description is a usage lecture of about 340
 * tokens. Under the lean flag the same executor ships with a description of
 * the arguments and output only.
 */
export function selectReadFile<TInput, TOutput>(flags: Pick<HarnessFlags, "leanTools">, definition: ToolDefinition<TInput, TOutput>): ToolDefinition<TInput, TOutput> {
  return flags.leanTools ? defineTool({ ...definition, description: LEAN_READ_FILE_DESCRIPTION }) : definition;
}

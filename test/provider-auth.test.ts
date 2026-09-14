import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runCli } from "../scripts/provider-auth.js";

test("provider-auth strictly validates action and worker kind", () => {
  assert.deepEqual(parseArgs(["status", "cursor-agent"]), { action: "status", kind: "cursor-agent" });
  assert.deepEqual(parseArgs(["login", "claude-code"]), { action: "login", kind: "claude-code" });
  assert.equal(parseArgs([]), undefined);
  assert.equal(parseArgs(["status", "cursor-agent", "extra"]), undefined);
  assert.equal(parseArgs(["whoami", "cursor-agent"]), undefined);
  assert.equal(parseArgs(["status", "other"]), undefined);
});

test("provider-auth projects status and login to generic JSON", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const statusCode = await runCli(["status", "cursor-agent"], {
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
    status: async () => "authenticated",
  });
  assert.equal(statusCode, 0);
  assert.deepEqual(JSON.parse(output[0]), { provider: "cursor-agent", status: "authenticated" });
  assert.deepEqual(errors, []);

  output.length = 0;
  const loginCode = await runCli(["login", "claude-code"], {
    stdout: (value) => output.push(value),
    login: async () => ({ status: "blocked" }),
  });
  assert.equal(loginCode, 0);
  assert.deepEqual(JSON.parse(output[0]), { provider: "claude-code", status: "blocked" });
});

test("provider-auth rejects invalid invocation without provider output", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["status", "cursor-agent", "unexpected"], {
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
  });
  assert.equal(code, 2);
  assert.deepEqual(output, []);
  assert.deepEqual(errors, ["provider-auth: invalid arguments\n"]);
});

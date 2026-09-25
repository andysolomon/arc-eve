import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, runCli } from "../scripts/provider-auth.js";

const toolsDir = fileURLToPath(new URL("../agent/tools", import.meta.url));
const leakMarkers = [
  "acct_12345",
  "operator@example.test",
  "Authenticated as Alice Example; raw vendor blob",
  "sk-live-secret-token",
  "CURSOR_API_KEY=super-secret",
];

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

test("provider-auth strictly validates action and worker kind", () => {
  assert.deepEqual(parseArgs(["status", "cursor-agent"]), { action: "status", kind: "cursor-agent" });
  assert.deepEqual(parseArgs(["login", "claude-code"]), { action: "login", kind: "claude-code" });
  assert.deepEqual(parseArgs(["status", "both"]), { action: "status", kind: "both" });
  assert.deepEqual(parseArgs(["login", "both"]), { action: "login", kind: "both" });
  assert.equal(parseArgs([]), undefined);
  assert.equal(parseArgs(["status", "cursor-agent", "extra"]), undefined);
  assert.equal(parseArgs(["whoami", "cursor-agent"]), undefined);
  assert.equal(parseArgs(["status", "other"]), undefined);
});

test("both-kind exit codes are the union of per-kind rules", async () => {
  const bothOk = capture();
  assert.equal(await runCli(["status", "both"], {
    ...bothOk.options,
    status: async (kind) => (kind === "cursor-agent" ? "authenticated" : "unknown"),
  }), 0);
  assert.deepEqual(bothOk.stderr, []);

  const mixed = capture();
  assert.equal(await runCli(["login", "both"], {
    ...mixed.options,
    login: async (kind) => {
      if (kind === "claude-code") throw new Error(leakMarkers.join(" "));
      return { status: "completed" as const };
    },
  }), 1);
  assert.deepEqual(mixed.stdout.map((line) => JSON.parse(line)), [
    { provider: "cursor-agent", status: "completed" },
  ]);
  assert.deepEqual(mixed.stderr, ["provider-auth: operation failed\n"]);
  const mixedText = `${mixed.stdout.join("")}${mixed.stderr.join("")}`;
  for (const marker of leakMarkers) assert.equal(mixedText.includes(marker), false);

  const bothFail = capture();
  assert.equal(await runCli(["status", "both"], {
    ...bothFail.options,
    status: async () => {
      throw new Error(leakMarkers.join(" "));
    },
  }), 1);
  assert.deepEqual(bothFail.stdout, []);
  assert.deepEqual(bothFail.stderr, ["provider-auth: operation failed\n"]);
});

test("agent/tools does not import provider-auth for callable registration", async () => {
  const names = await readdir(toolsDir);
  const forbidden = /provider-auth|providerLogin|providerStatus|arc-auth/;
  for (const name of names.filter((entry) => entry.endsWith(".ts"))) {
    const source = await readFile(join(toolsDir, name), "utf8");
    assert.equal(forbidden.test(source), false, name);
  }
});

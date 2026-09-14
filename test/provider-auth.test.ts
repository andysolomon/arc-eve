import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, runCli } from "../scripts/provider-auth.js";

const fourStates = ["missing", "authenticated", "unauthenticated", "unknown"] as const;
const kinds = ["cursor-agent", "claude-code"] as const;
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

test("four-state status projection is distinct and stable per kind", async () => {
  for (const kind of kinds) {
    const seen = new Set<string>();
    for (const status of fourStates) {
      const run = capture();
      const code = await runCli(["status", kind], {
        ...run.options,
        status: async () => status,
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(run.stdout[0]);
      assert.deepEqual(parsed, { provider: kind, status });
      assert.deepEqual(Object.keys(parsed), ["provider", "status"]);
      assert.deepEqual(run.stderr, []);
      seen.add(JSON.stringify(parsed));
    }
    assert.equal(seen.size, fourStates.length);
  }
});

test("both-kind status and login project per-kind JSON without identifiers", async () => {
  const statusRun = capture();
  const statusCode = await runCli(["status", "both"], {
    ...statusRun.options,
    status: async (kind) => (kind === "cursor-agent" ? "unauthenticated" : "missing"),
  });
  assert.equal(statusCode, 0);
  assert.deepEqual(statusRun.stdout.map((line) => JSON.parse(line)), [
    { provider: "cursor-agent", status: "unauthenticated" },
    { provider: "claude-code", status: "missing" },
  ]);
  assert.deepEqual(statusRun.stderr, []);

  const loginRun = capture();
  const loginCode = await runCli(["login", "both"], {
    ...loginRun.options,
    login: async (kind) => ({
      status: kind === "cursor-agent" ? "completed" : "blocked",
      account: leakMarkers[0],
      email: leakMarkers[1],
      raw: leakMarkers[2],
      credentials: leakMarkers[3],
      token: leakMarkers[4],
    }),
  });
  assert.equal(loginCode, 0);
  assert.deepEqual(loginRun.stdout.map((line) => JSON.parse(line)), [
    { provider: "cursor-agent", status: "completed" },
    { provider: "claude-code", status: "blocked" },
  ]);
  const combined = `${loginRun.stdout.join("")}${loginRun.stderr.join("")}`;
  for (const marker of leakMarkers) assert.equal(combined.includes(marker), false);
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

test("providerLogin and providerStatus are not Eve tool handlers", async () => {
  const names = await readdir(toolsDir);
  assert.equal(names.some((name) => /arc[-_](login|auth)/.test(name)), false);
  for (const name of names.filter((entry) => entry.endsWith(".ts"))) {
    const source = await readFile(join(toolsDir, name), "utf8");
    assert.doesNotMatch(source, /defineTool\([\s\S]{0,400}(providerLogin|providerStatus|arc-login|arc-auth-status)/);
    assert.doesNotMatch(source, /providerLogin|providerStatus/);
  }
});

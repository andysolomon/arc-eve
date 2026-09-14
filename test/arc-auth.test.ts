import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProviderStatus, providerLogin, providerStatus } from "../agent/lib/arc-auth.js";
import { configuredWorkerBinaries } from "../agent/lib/worker-binaries.js";

test("worker binaries prefer canonical explicit configuration and never search PATH", () => {
  const bins = configuredWorkerBinaries({
    ARC_ORCHESTRATOR_CURSOR_BIN: "./canonical/cursor",
    CURSOR_AGENT_BIN: "./alias/cursor",
    ARC_ORCHESTRATOR_CLAUDE_BIN: "/opt/canonical-claude",
    CLAUDE_CODE_BIN: "/opt/alias-claude",
  }, "/srv/app");
  assert.deepEqual(bins, {
    "cursor-agent": "/srv/app/canonical/cursor",
    "claude-code": "/opt/canonical-claude",
  });
  assert.deepEqual(configuredWorkerBinaries({ CURSOR_AGENT_BIN: "./vendor/cursor", CLAUDE_CODE_BIN: "/opt/claude" }, "/srv/app"), {
    "cursor-agent": "/srv/app/vendor/cursor",
    "claude-code": "/opt/claude",
  });
  assert.deepEqual(configuredWorkerBinaries({ PATH: "/bin" }, "/srv/app"), {});
});

test("provider status classification is conservative and bounded to four states", () => {
  assert.equal(classifyProviderStatus(0, "authenticated"), "authenticated");
  assert.equal(classifyProviderStatus(1, "not logged in"), "unauthenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ authenticated: true, account: "private@example.test" })), "authenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ isAuthenticated: false })), "unauthenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ loggedIn: true })), "authenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ logged_in: false })), "unauthenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ authStatus: "logged_in" })), "authenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ loginStatus: "expired" })), "unauthenticated");
  assert.equal(classifyProviderStatus(0, JSON.stringify({ account: "authenticated-user@example.test" })), "unknown");
  assert.equal(classifyProviderStatus(0, "ok"), "unknown");
  assert.equal(classifyProviderStatus(null, "vendor instructions"), "unknown");
});

test("providers receive exact argv and the canonical selected binary environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-auth-argv-"));
  const fake = join(dir, "fake-provider");
  const badAlias = join(dir, "must-not-run");
  const calls = join(dir, "calls");
  await writeFile(fake, `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),cursor:process.env.ARC_ORCHESTRATOR_CURSOR_BIN,claude:process.env.ARC_ORCHESTRATOR_CLAUDE_BIN})+"\\n");if(process.argv.includes("status"))process.stdout.write(JSON.stringify({authenticated:true}));\n`, { mode: 0o755 });
  await chmod(fake, 0o755);
  const env = {
    ...process.env,
    CALLS: calls,
    ARC_ORCHESTRATOR_CURSOR_BIN: fake,
    CURSOR_AGENT_BIN: badAlias,
    ARC_ORCHESTRATOR_CLAUDE_BIN: fake,
    CLAUDE_CODE_BIN: badAlias,
  };

  assert.equal(await providerStatus("cursor-agent", env, dir), "authenticated");
  assert.deepEqual(await providerLogin("cursor-agent", env, dir), { status: "completed" });
  assert.equal(await providerStatus("claude-code", env, dir), "authenticated");
  assert.deepEqual(await providerLogin("claude-code", env, dir), { status: "completed" });

  const recorded = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(recorded.map(({ args }) => args), [
    ["status", "--format", "json"],
    ["login"],
    ["auth", "status", "--json"],
    ["auth", "login"],
  ]);
  assert.ok(recorded.every(({ cursor, claude }) => cursor === fake && claude === fake));
});

test("provider timeout escalates termination and returns only generic states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-auth-"));
  const fake = join(dir, "fake-provider");
  const pidFile = join(dir, "pid");
  const termFile = join(dir, "term");
  await writeFile(fake, `#!${process.execPath}\nconst fs=require("node:fs");fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.stdout.write("authenticated token=provider-secret\\n");process.on("SIGTERM",()=>fs.appendFileSync(process.env.TERM_FILE,"term\\n"));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  await chmod(fake, 0o755);
  const env = { ...process.env, ARC_ORCHESTRATOR_CURSOR_BIN: fake, PID_FILE: pidFile, TERM_FILE: termFile };
  const timing = { timeoutMs: 500, killGraceMs: 30 };
  assert.equal(await providerStatus("cursor-agent", env, dir, timing), "unknown");
  assert.deepEqual(await providerLogin("cursor-agent", env, dir, timing), { status: "blocked" });
  assert.match(await readFile(termFile, "utf8"), /term/);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});

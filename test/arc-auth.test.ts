import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProviderStatus, providerStatus } from "../agent/lib/arc-auth.js";

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

test("provider status discovers PATH-only binaries and treats non-executables as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-auth-path-"));
  const fake = join(dir, "cursor-agent");
  await writeFile(fake, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({authenticated:true}));\n`, { mode: 0o755 });
  await chmod(fake, 0o755);
  const {
    ARC_ORCHESTRATOR_CURSOR_BIN: _cursor,
    CURSOR_AGENT_BIN: _cursorAlias,
    ARC_ORCHESTRATOR_CLAUDE_BIN: _claude,
    CLAUDE_CODE_BIN: _claudeAlias,
    ...rest
  } = process.env;
  assert.equal(await providerStatus("cursor-agent", { ...rest, PATH: dir }, dir), "authenticated");

  const noexecDir = await mkdtemp(join(tmpdir(), "arc-auth-noexec-"));
  const noexec = join(noexecDir, "cursor-agent");
  await writeFile(noexec, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({authenticated:true}));\n`, { mode: 0o644 });
  await chmod(noexec, 0o644);
  assert.equal(await providerStatus("cursor-agent", { ...rest, PATH: noexecDir }, noexecDir), "missing");
});

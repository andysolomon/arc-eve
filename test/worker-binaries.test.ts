import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredWorkerBinaries,
  findExecutableInPath,
  resolveWorkerBinary,
  resolveWorkerBinaries,
} from "../agent/lib/worker-binaries.js";

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

async function stamp(dir: string, name: string, mode = 0o755): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n", { mode });
  await chmod(path, mode);
  return path;
}

test("resolveWorkerBinary prefers canonical over alias over PATH for both kinds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-worker-bin-"));
  const cursorCanonical = await stamp(dir, "canonical-cursor");
  const cursorAlias = await stamp(dir, "alias-cursor");
  const cursorPath = await stamp(dir, "cursor-agent");
  const claudeCanonical = await stamp(dir, "canonical-claude");
  const claudeAlias = await stamp(dir, "alias-claude");
  const claudePath = await stamp(dir, "claude");

  const canonical = await resolveWorkerBinaries({
    ARC_ORCHESTRATOR_CURSOR_BIN: cursorCanonical,
    CURSOR_AGENT_BIN: cursorAlias,
    ARC_ORCHESTRATOR_CLAUDE_BIN: claudeCanonical,
    CLAUDE_CODE_BIN: claudeAlias,
    PATH: dir,
  }, dir);
  assert.deepEqual(canonical, { "cursor-agent": cursorCanonical, "claude-code": claudeCanonical });

  const alias = await resolveWorkerBinaries({
    CURSOR_AGENT_BIN: cursorAlias,
    CLAUDE_CODE_BIN: claudeAlias,
    PATH: dir,
  }, dir);
  assert.deepEqual(alias, { "cursor-agent": cursorAlias, "claude-code": claudeAlias });

  const pathOnly = await resolveWorkerBinaries({ PATH: dir }, dir);
  assert.deepEqual(pathOnly, { "cursor-agent": cursorPath, "claude-code": claudePath });
});

test("resolveWorkerBinary fail-closes invalid explicit paths and never falls through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-worker-bin-miss-"));
  const cursorAlias = await stamp(dir, "alias-cursor");
  const cursorPath = await stamp(dir, "cursor-agent");
  const claudePath = await stamp(dir, "claude");
  const missing = join(dir, "does-not-exist");
  const noexec = await stamp(dir, "noexec", 0o644);

  const invalidCursor = await resolveWorkerBinary("cursor-agent", {
    ARC_ORCHESTRATOR_CURSOR_BIN: missing,
    CURSOR_AGENT_BIN: cursorAlias,
    PATH: dir,
  }, dir);
  assert.equal(invalidCursor.path, undefined);
  assert.equal(invalidCursor.reason, "invalid");
  assert.notEqual(invalidCursor.path, cursorPath);

  const invalidClaude = await resolveWorkerBinary("claude-code", {
    CLAUDE_CODE_BIN: missing,
    PATH: dir,
  }, dir);
  assert.equal(invalidClaude.path, undefined);
  assert.equal(invalidClaude.reason, "invalid");
  assert.notEqual(invalidClaude.path, claudePath);

  const unavailable = await resolveWorkerBinary("cursor-agent", {
    ARC_ORCHESTRATOR_CURSOR_BIN: noexec,
    PATH: dir,
  }, dir);
  assert.equal(unavailable.path, undefined);
  assert.equal(unavailable.reason, "unavailable");

  const bins = await resolveWorkerBinaries({
    ARC_ORCHESTRATOR_CURSOR_BIN: missing,
    PATH: dir,
  }, dir);
  assert.equal(bins["cursor-agent"], undefined);
  assert.equal(bins["claude-code"], claudePath);
});

test("findExecutableInPath requires a regular X_OK file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arc-worker-bin-path-"));
  const found = await stamp(dir, "cursor-agent");
  assert.equal(await findExecutableInPath("cursor-agent", { PATH: dir }, dir), found);

  const noexecDir = await mkdtemp(join(tmpdir(), "arc-worker-bin-noexec-"));
  await stamp(noexecDir, "cursor-agent", 0o644);
  assert.equal(await findExecutableInPath("cursor-agent", { PATH: noexecDir }, noexecDir), undefined);
  assert.equal((await resolveWorkerBinary("cursor-agent", { PATH: noexecDir }, noexecDir)).reason, "missing");
});

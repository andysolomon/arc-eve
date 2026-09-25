import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDotEnvLocal,
  redactParentProviderText,
  resolveParentProvider,
} from "../agent/lib/parent-provider.js";
import { runCli } from "../scripts/parent-provider.js";

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arc-eve-parent-provider-"));
}

test("process.env wins over .env.local and defaults", async () => {
  const cwd = await tempCwd();
  await writeFile(join(cwd, ".env.local"), [
    "EVE_PARENT_PROVIDER=file-provider",
    "EVE_PARENT_MODEL=file-model",
    "EVE_PARENT_API_KEY=file-placeholder",
  ].join("\n"));

  const fromEnv = resolveParentProvider({
    cwd,
    env: {
      EVE_PARENT_PROVIDER: "env-provider",
      EVE_PARENT_MODEL: "env-model",
      EVE_PARENT_API_KEY: "env-placeholder",
    },
  });
  assert.deepEqual(fromEnv, {
    provider: "env-provider",
    model: "env-provider/env-model",
    credentialPresent: true,
  });

  const fromFile = resolveParentProvider({ cwd, env: {} });
  assert.equal(fromFile.provider, "file-provider");
  assert.equal(fromFile.model, "file-provider/file-model");
  assert.equal(fromFile.credentialPresent, true);
});

test("canonical variables win over compatibility aliases", () => {
  const resolved = resolveParentProvider({
    env: {
      ARC_ORCHESTRATOR_PROVIDER: "alias-provider",
      ARC_ORCHESTRATOR_MODEL: "alias-model",
      ARC_ORCHESTRATOR_API_KEY: "alias-placeholder",
      EVE_PARENT_PROVIDER: "canonical-provider",
      EVE_PARENT_MODEL: "canonical-model",
      EVE_PARENT_API_KEY: "canonical-placeholder",
    },
    cwd: "/path/that/does/not/exist",
  });
  assert.equal(resolved.provider, "canonical-provider");
  assert.equal(resolved.model, "canonical-provider/canonical-model");
  assert.equal(resolved.credentialPresent, true);

  const aliasOnly = resolveParentProvider({
    env: { ARC_ORCHESTRATOR_PROVIDER: "alias-provider", ARC_ORCHESTRATOR_MODEL: "alias-model" },
    cwd: "/path/that/does/not/exist",
  });
  assert.equal(aliasOnly.provider, "alias-provider");
  assert.equal(aliasOnly.model, "alias-provider/alias-model");
});

test("check has a generic missing message and accepts a dotenv placeholder", async () => {
  const missingStdout: string[] = [];
  const missingStderr: string[] = [];
  const missingCode = runCli(["check"], {
    cwd: await tempCwd(),
    env: {},
    stdout: (value) => missingStdout.push(value),
    stderr: (value) => missingStderr.push(value),
  });
  assert.equal(missingCode, 1);
  assert.equal(JSON.parse(missingStdout[0]).credential, "missing");
  assert.doesNotMatch(missingStderr.join(""), /GatewayAuthenticationError|stack|api key value/i);

  const cwd = await tempCwd();
  await writeFile(join(cwd, ".env.local"), "EVE_PARENT_API_KEY=placeholder-not-a-secret\n");
  const configuredStdout: string[] = [];
  const configuredStderr: string[] = [];
  const configuredCode = runCli(["--", "check"], {
    cwd,
    env: {},
    stdout: (value) => configuredStdout.push(value),
    stderr: (value) => configuredStderr.push(value),
  });
  assert.equal(configuredCode, 0);
  assert.equal(JSON.parse(configuredStdout[0]).credential, "configured");
  assert.deepEqual(configuredStderr, []);
});

test("malformed .env.local input is tolerated", async () => {
  assert.deepEqual(parseDotEnvLocal("not dotenv\nEVE_PARENT_MODEL=valid-model\n=bad\nEVE_PARENT_PROVIDER='unterminated"), {
    EVE_PARENT_MODEL: "valid-model",
  });

  const cwd = await tempCwd();
  await writeFile(join(cwd, ".env.local"), "not dotenv\nEVE_PARENT_MODEL=valid-model\n=bad\n");
  assert.equal(resolveParentProvider({ cwd, env: {} }).model, "openai/valid-model");
});

test("redactParentProviderText removes assignment-style api_key and secret values", () => {
  const apiKeyValue = "supersecret-api-value";
  const secretValue = "supersecret-password-value";
  const redacted = redactParentProviderText(
    `prefix api_key=${apiKeyValue} mid secret=${secretValue} suffix`,
  );
  assert.equal(redacted.includes(apiKeyValue), false);
  assert.equal(redacted.includes(secretValue), false);
  assert.equal(redacted.includes(`api_key=${apiKeyValue}`), false);
  assert.equal(redacted.includes(`secret=${secretValue}`), false);
});

test("redactParentProviderText removes credential-like sk-, AIza, github_pat, and JWT patterns", () => {
  const sk = "sk-abcdefghijklmnopqrstuvwxyz1234";
  const aiza = "AIzaSyDummyGoogleMapsKeyABCDEFGHIJ";
  const githubPat = "github_pat_abcdefghijklmnopqrst";
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
  const redacted = redactParentProviderText(`keep ${sk} ${aiza} ${githubPat} ${jwt} end`);
  assert.equal(redacted.includes(sk), false);
  assert.equal(redacted.includes(aiza), false);
  assert.equal(redacted.includes(githubPat), false);
  assert.equal(redacted.includes(jwt), false);
});

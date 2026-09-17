import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { justbash } from "eve/sandbox/just-bash";
import type { SandboxDefinition } from "eve/sandbox";
import agentSandbox from "../agent/sandbox.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const sandboxPath = resolve(repoRoot, "agent/sandbox.ts");

// Static import so tsx rewrites `../agent/sandbox.js` to `../agent/sandbox.ts`
// when running under `node --test --import tsx`. The path lives in the
// conventional nested-agent location so eve's compiler picks it up
// automatically without `agent.ts` having to import it.
const sandboxDefinition = agentSandbox as SandboxDefinition;

test("agent/sandbox.ts exists at the canonical nested-agent path", () => {
  assert.ok(
    existsSync(sandboxPath),
    `expected sandbox.ts at ${sandboxPath} so eve can auto-discover it`,
  );
});

test("agent/sandbox.ts pins the just-bash backend", () => {
  const definition = sandboxDefinition;
  assert.ok(definition, "default export must be a sandbox definition");
  assert.equal(
    typeof definition.backend,
    "object",
    "definition must carry a backend instance",
  );
  assert.ok(definition.backend, "backend must be present");
  assert.equal(
    definition.backend.name,
    "just-bash",
    "the parent must use just-bash — microsandbox and docker need operator setup the spike does not require",
  );
  // No bootstrap hook — the parent only needs a flat runtime.
  assert.equal(
    (definition as { bootstrap?: unknown }).bootstrap,
    undefined,
    "the parent sandbox must not declare a bootstrap hook",
  );
});

test("justbash() factory returns a usable backend handle shape", () => {
  const backend = justbash();
  assert.equal(backend.name, "just-bash");
  assert.equal(typeof backend.prewarm, "function");
  assert.equal(typeof backend.create, "function");
});

test("agent/sandbox.ts does not import or call the heavier backends that need operator setup", () => {
  const source = readFileSync(sandboxPath, "utf8");
  // Defense against accidentally regressing to the microsandbox path (which
  // fails to auto-install on a pnpm workspace root) or to docker (which
  // requires a running daemon and docker group membership). Comments are
  // allowed to mention them — only imports and factory calls trip the test.
  assert.doesNotMatch(
    source,
    /from\s+["']eve\/sandbox\/(?:microsandbox|docker|vercel)["']/,
    "do not import a heavier backend — the parent must stay on justbash()",
  );
  assert.doesNotMatch(
    source,
    /\b(?:microsandbox|docker|vercel)\s*\(/,
    "do not call a heavier backend factory — the parent must stay on justbash()",
  );
});

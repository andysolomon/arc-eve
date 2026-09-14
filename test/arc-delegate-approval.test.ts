import test from "node:test";
import assert from "node:assert/strict";
import tool, { delegateTaskContract, validateDelegateInput } from "../agent/tools/arc_delegate.ts";

const base = {
  outcome: "ship",
  scope: "agent/tools only",
  verification: "focused tests",
  preserved_behavior: "runner routing and host checkout",
  prohibitions: "no secrets",
  label: "issue-3",
  cwd: ".",
};

test("arc_delegate is statically always-gated", async () => {
  assert.equal(typeof (tool as any).approval, "function");
  // This verifies Eve's policy declaration, not an Eve UI interaction.
  assert.equal(await (tool as any).approval({}), "user-approval");
});

test("explore, research, and plan remain valid approval-gated phases", () => {
  for (const phase of ["explore", "research", "plan"] as const) {
    assert.equal(validateDelegateInput({ ...base, phase }).phase, phase);
  }
});

test("Implement and Deploy fail closed before runner work", () => {
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement" }), /workload_class/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement", workload_class: "not-canonical", implement_authorized: true } as any), /workload_class/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "implement", workload_class: "easy-light" }), /authorization/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "deploy" }), /Deploy requires/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "deploy", deploy_authorized: true, background: true }), /background|synchronous/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "explore", implement_authorized: false }), /only valid for Implement/);
  assert.throws(() => validateDelegateInput({ ...base, phase: "verify", deploy_authorized: false }), /only valid for Deploy/);
});

test("runner task is the bounded sanitized ARC text contract", () => {
  const value = delegateTaskContract({ ...base, label: " Unsafe Label /home/me ", context: "ticket context\nuser: raw prompt\n/home/me/private\ntoken=secret-value", decision_refs: ["private-ref"], assumption_refs: ["private-assumption"] });
  assert.match(value, /^You are an ARC worker\. Phase: explore\. Mode: analyze\. Route: automatic runner-routing-v4 \(analyze\)\./);
  for (const heading of ["Safe label: unsafe-label-home-me", "Outcome:\nship", "Scope:\nagent/tools only", "Preserved behavior:", "Verification:", "Prohibitions:", "Context:\nticket context"]) assert(value.includes(heading));
  for (const prohibition of ["commit", "push", "pull requests", "merge", "deploy", "GitHub", "secrets", "nested", "unrelated files"]) assert(value.includes(prohibition));
  for (const forbidden of ["implement_authorized", "deploy_authorized", "private-ref", "private-assumption", "secret-value", "/home/me", "user: raw prompt"]) assert(!value.includes(forbidden));
  assert(value.includes("[path]") && value.includes("[redacted]") && value.includes("[transcript redacted]"));
  assert(value.length < 24000);
});

test("explicit contract identifies its public route", () => {
  const value = delegateTaskContract({ ...base, phase: "verify", route: "sol-check" });
  assert.match(value, /Phase: verify\. Mode: review\. Route: explicit route sol-check\./);
});

test("an already-cancelled call is rejected without runner discovery", async () => {
  const result = await (tool as any).execute({ ...base, phase: "explore" }, {
    abortSignal: AbortSignal.abort(),
    session: { id: "test" },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.risks.join(" "), /runner was not started/);
});

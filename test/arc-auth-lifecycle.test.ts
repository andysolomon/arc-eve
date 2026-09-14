import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerLogin, providerStatus } from "../agent/lib/arc-auth.js";

const SECRET = "sk-test-1234567890abcdef";
const FULL_URL = `https://authenticator.cursor.sh/login?code=device-secret&token=${SECRET}`;
const REDACTED_URL = "https://authenticator.cursor.sh";
const RAW = "RAW_OUTPUT_SECRET";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arc-auth-lifecycle-"));
}

async function writeFake(dir: string, source: string): Promise<string> {
  const fake = join(dir, "fake-provider");
  await writeFile(fake, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  await chmod(fake, 0o755);
  return fake;
}

function envFor(dir: string, fake: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARC_ORCHESTRATOR_CURSOR_BIN: fake,
    ARC_ORCHESTRATOR_CLAUDE_BIN: fake,
    ARC_PI_HOME: join(dir, ".arc-pi"),
    ...extra,
  };
}

async function plantSinks(dir: string): Promise<void> {
  await mkdir(join(dir, ".eve", "traces"), { recursive: true });
  await mkdir(join(dir, ".eve", "logs"), { recursive: true });
  await writeFile(join(dir, ".eve", "traces", "run.log"), "trace-start\n");
  await writeFile(join(dir, ".eve", "logs", "agent.log"), "log-start\n");
  await writeFile(join(dir, "history"), "prompt-history-start\n");
  await writeFile(join(dir, "registry"), "{}\n");
}

async function readSinks(dir: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(root: string) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        try { chunks.push(await readFile(path, "utf8")); } catch { /* ignore unreadable */ }
      }
    }
  }
  await walk(join(dir, ".eve"));
  await walk(join(dir, ".arc-pi"));
  for (const name of ["history", "registry"]) {
    try { chunks.push(await readFile(join(dir, name), "utf8")); } catch { /* optional sink */ }
  }
  return chunks.join("\n");
}

function captureConsole(): { history: string[]; restore: () => void } {
  const history: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = Object.fromEntries(methods.map((name) => [name, console[name].bind(console)])) as Record<typeof methods[number], typeof console.log>;
  const push = (...args: unknown[]) => history.push(args.map((value) => String(value)).join(" "));
  for (const name of methods) console[name] = (...args: unknown[]) => { push(...args); original[name](...args); };
  (console as { history?: string[] }).history = history;
  return {
    history,
    restore: () => {
      for (const name of methods) console[name] = original[name];
      delete (console as { history?: string[] }).history;
    },
  };
}

function assertAbsent(secret: string, result: unknown, consoleHistory: string[], sinks: string): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false, "result leaked secret");
  assert.equal(consoleHistory.some((line) => line.includes(secret)), false, "console.history leaked secret");
  assert.equal(sinks.includes(secret), false, "registry/.eve/history leaked secret");
}

test("bounded login output is discarded and never written to sinks", async () => {
  const dir = await tempDir();
  await plantSinks(dir);
  const fake = await writeFake(dir, [
    `const fs=require("node:fs");`,
    `fs.appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+"\\n");`,
    `process.stdout.write(${JSON.stringify(SECRET + "\\n")});`,
    `process.stdout.write("x".repeat(20000));`,
    `process.stdout.write("TAIL_MARKER_AFTER_BOUND\\n");`,
    `if(process.argv.includes("status"))process.stdout.write(JSON.stringify({authenticated:true}));`,
  ].join("\n"));
  const calls = join(dir, "calls");
  const env = envFor(dir, fake, { CALLS: calls });
  const consoleCap = captureConsole();
  try {
    const result = await providerLogin("cursor-agent", env, dir);
    assert.equal(result.status, "completed");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes("TAIL_MARKER_AFTER_BOUND"), false);
    assert.equal(serialized.includes("x".repeat(32)), false);
    assertAbsent(SECRET, result, consoleCap.history, await readSinks(dir));
    assert.equal((await readFile(join(dir, ".eve", "traces", "run.log"), "utf8")).includes(SECRET), false);
    assert.equal((await readFile(join(dir, ".eve", "logs", "agent.log"), "utf8")).includes(SECRET), false);
    assert.equal((await readFile(join(dir, "history"), "utf8")).includes(SECRET), false);
    assert.equal((await readFile(join(dir, "registry"), "utf8")).includes(SECRET), false);
  } finally {
    consoleCap.restore();
  }
});

test("SIGTERM then SIGKILL terminates a stalled login within the configured bound", async () => {
  const dir = await tempDir();
  const pidFile = join(dir, "pid");
  const termFile = join(dir, "term");
  const fake = await writeFake(dir, [
    `const fs=require("node:fs");`,
    `fs.writeFileSync(process.env.PID_FILE,String(process.pid));`,
    `process.on("SIGTERM",()=>fs.appendFileSync(process.env.TERM_FILE,"term\\n"));`,
    `setInterval(()=>{},1000);`,
  ].join("\n"));
  const env = envFor(dir, fake, { PID_FILE: pidFile, TERM_FILE: termFile });
  const timing = { timeoutMs: 200, killGraceMs: 40 };
  const started = Date.now();
  const result = await providerLogin("cursor-agent", env, dir, timing);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { status: "blocked", postLoginStatus: "unknown" });
  assert.match(await readFile(termFile, "utf8"), /term/);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  assert.ok(elapsed < timing.timeoutMs + timing.killGraceMs * 2 + 1500);
});

test("login deadline is configurable and returns a generic blocked result", async () => {
  const dir = await tempDir();
  const fake = await writeFake(dir, `process.stdout.write(${JSON.stringify(RAW + "\\n")});setInterval(()=>{},1000);\n`);
  const env = envFor(dir, fake);
  const started = Date.now();
  const result = await providerLogin("claude-code", env, dir, { timeoutMs: 120, killGraceMs: 30 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { status: "blocked", postLoginStatus: "unknown" });
  assert.equal(JSON.stringify(result).includes(RAW), false);
  assert.ok(elapsed < 120 + 30 * 2 + 1500);
});

test("CURSOR_API_KEY skips cursor-agent login spawn and never discloses the key", async () => {
  const dir = await tempDir();
  await plantSinks(dir);
  const calls = join(dir, "calls");
  const loginRan = join(dir, "login-ran");
  const fake = await writeFake(dir, [
    `const fs=require("node:fs");`,
    `fs.appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+"\\n");`,
    `if(process.argv.includes("login"))fs.writeFileSync(process.env.LOGIN_RAN,"yes");`,
    `process.stdout.write(JSON.stringify({authenticated:true,key:process.env.CURSOR_API_KEY}));`,
  ].join("\n"));
  const env = envFor(dir, fake, { CALLS: calls, LOGIN_RAN: loginRan, CURSOR_API_KEY: SECRET });
  const consoleCap = captureConsole();
  try {
    const result = await providerLogin("cursor-agent", env, dir);
    assert.deepEqual(result, {
      status: "completed",
      postLoginStatus: "authenticated",
      credentialSource: "cursor-api-key",
    });
    const recorded = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(recorded, [["status", "--format", "json"]]);
    await assert.rejects(() => readFile(loginRan, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assertAbsent(SECRET, result, consoleCap.history, await readSinks(dir));
  } finally {
    consoleCap.restore();
  }
});

test("cursor-agent browser URL is captured once, redacted to scheme+host, and absent from other sinks", async () => {
  const dir = await tempDir();
  await plantSinks(dir);
  const second = "https://evil.example.test/other?token=second-secret";
  const fake = await writeFake(dir, [
    `process.stdout.write(${JSON.stringify(`Visit ${FULL_URL} to continue\\n`)});`,
    `process.stderr.write(${JSON.stringify(`${second}\\n`)});`,
  ].join("\n"));
  const env = envFor(dir, fake);
  const consoleCap = captureConsole();
  try {
    const result = await providerLogin("cursor-agent", env, dir);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.browserGuidance, { url: REDACTED_URL });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(FULL_URL), false);
    assert.equal(serialized.includes("device-secret"), false);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes("evil.example.test"), false);
    assert.equal(serialized.includes(second), false);
    assert.equal(result.browserGuidance?.url, REDACTED_URL);
    assertAbsent(SECRET, result, consoleCap.history, await readSinks(dir));
    assertAbsent(FULL_URL, result, consoleCap.history, await readSinks(dir));
    assert.equal((await readSinks(dir)).includes("authenticator.cursor.sh/login"), false);
  } finally {
    consoleCap.restore();
  }
});

function argvSpyFake(loginJson: string, statusJson: string, writeLogin = true): string {
  return [
    `const fs=require("node:fs");`,
    `fs.appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+"\\n");`,
    `const cmd=process.argv[2];`,
    `const isLogin=cmd==="login"||process.argv[3]==="login";`,
    `const isStatus=cmd==="status"||process.argv[3]==="status";`,
    `if(isLogin)${writeLogin ? `process.stdout.write(${JSON.stringify(loginJson)})` : "undefined"};`,
    `else if(isStatus)process.stdout.write(${JSON.stringify(statusJson)});`,
  ].join("\n");
}

async function recordedArgv(calls: string): Promise<string[][]> {
  return (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

test("post-login status probe maps the four generic states", async () => {
  const dir = await tempDir();
  const cursorCalls = join(dir, "cursor-calls");
  const authenticated = await writeFake(dir, argvSpyFake(
    JSON.stringify({ authenticated: false, source: "login" }),
    JSON.stringify({ authenticated: true, source: "status" }),
  ));
  assert.deepEqual(await providerLogin("cursor-agent", envFor(dir, authenticated, { CALLS: cursorCalls }), dir), {
    status: "completed",
    postLoginStatus: "authenticated",
  });
  assert.deepEqual(await recordedArgv(cursorCalls), [["login"], ["status", "--format", "json"]]);
  assert.equal(await providerStatus("cursor-agent", envFor(dir, authenticated, { CALLS: join(dir, "status-only") }), dir), "authenticated");

  const claudeCalls = join(dir, "claude-calls");
  const unauthenticated = await writeFake(dir, argvSpyFake(
    JSON.stringify({ authenticated: false }),
    JSON.stringify({ authenticated: false }),
  ));
  assert.deepEqual(await providerLogin("claude-code", envFor(dir, unauthenticated, { CALLS: claudeCalls }), dir), {
    status: "completed",
    postLoginStatus: "unauthenticated",
  });
  assert.deepEqual(await recordedArgv(claudeCalls), [["auth", "login"], ["auth", "status", "--json"]]);

  const unknown = await writeFake(dir, `process.stdout.write("vendor-status-schema-v9");\n`);
  assert.deepEqual(await providerLogin("cursor-agent", envFor(dir, unknown), dir), {
    status: "completed",
    postLoginStatus: "unknown",
  });

  const {
    ARC_ORCHESTRATOR_CURSOR_BIN: _cursor,
    CURSOR_AGENT_BIN: _cursorAlias,
    ARC_ORCHESTRATOR_CLAUDE_BIN: _claude,
    CLAUDE_CODE_BIN: _claudeAlias,
    ...rest
  } = process.env;
  assert.deepEqual(await providerLogin("cursor-agent", { ...rest, PATH: "/nonexistent-arc-auth-lifecycle" }, dir), {
    status: "blocked",
    postLoginStatus: "missing",
  });

  const emptyDir = await tempDir();
  const emptyCalls = join(emptyDir, "calls");
  const emptyLogin = await writeFake(emptyDir, argvSpyFake("", JSON.stringify({ authenticated: true }), false));
  assert.deepEqual(await providerLogin("cursor-agent", envFor(emptyDir, emptyLogin, { CALLS: emptyCalls }), emptyDir), {
    status: "completed",
    postLoginStatus: "authenticated",
  });
  assert.deepEqual(await recordedArgv(emptyCalls), [["login"], ["status", "--format", "json"]]);

  const probeDir = await tempDir();
  const probeCalls = join(probeDir, "calls");
  const probeWins = await writeFake(probeDir, argvSpyFake(
    JSON.stringify({ authenticated: true }),
    JSON.stringify({ authenticated: false }),
  ));
  assert.deepEqual(await providerLogin("claude-code", envFor(probeDir, probeWins, { CALLS: probeCalls }), probeDir), {
    status: "completed",
    postLoginStatus: "unauthenticated",
  });
  assert.deepEqual(await recordedArgv(probeCalls), [["auth", "login"], ["auth", "status", "--json"]]);
});

test("cancellation returns unknown without raw output", async () => {
  const dir = await tempDir();
  await plantSinks(dir);
  const pidFile = join(dir, "pid");
  const fake = await writeFake(dir, [
    `const fs=require("node:fs");`,
    `fs.writeFileSync(process.env.PID_FILE,String(process.pid));`,
    `process.stdout.write(${JSON.stringify(RAW + " " + SECRET + "\\n")});`,
    `process.on("SIGTERM",()=>{});`,
    `setInterval(()=>{},1000);`,
  ].join("\n"));
  const env = envFor(dir, fake, { PID_FILE: pidFile, CURSOR_API_KEY: SECRET });
  const controller = new AbortController();
  const consoleCap = captureConsole();
  try {
    const pending = providerLogin("claude-code", env, dir, {
      timeoutMs: 15_000,
      killGraceMs: 40,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    const result = await pending;
    assert.deepEqual(result, { status: "blocked", postLoginStatus: "unknown" });
    assert.equal(JSON.stringify(result).includes(RAW), false);
    assertAbsent(SECRET, result, consoleCap.history, await readSinks(dir));
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    consoleCap.restore();
  }
});

test("credential values are absent from result, console.history, registry, and .eve artifacts", async () => {
  const dir = await tempDir();
  await plantSinks(dir);
  const fake = await writeFake(dir, [
    `process.stdout.write(${JSON.stringify(`token=${SECRET} account=private@example.test ${FULL_URL}\\n`)});`,
    `process.stdout.write(JSON.stringify({authenticated:true,account:"private@example.test"}));`,
  ].join("\n"));
  const env = envFor(dir, fake, { CURSOR_API_KEY: SECRET });
  const consoleCap = captureConsole();
  try {
    const keyPath = await providerLogin("cursor-agent", env, dir);
    assert.equal(keyPath.credentialSource, "cursor-api-key");
    assert.equal(JSON.stringify(keyPath).includes(SECRET), false);

    const { CURSOR_API_KEY: _key, ...withoutKey } = env;
    const login = await providerLogin("claude-code", withoutKey, dir);
    assert.equal(login.status, "completed");
    assert.equal(login.postLoginStatus, "authenticated");
    assertAbsent(SECRET, login, consoleCap.history, await readSinks(dir));
    assertAbsent("private@example.test", login, consoleCap.history, await readSinks(dir));
    assertAbsent(FULL_URL, login, consoleCap.history, await readSinks(dir));
  } finally {
    consoleCap.restore();
  }
});

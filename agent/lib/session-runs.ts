/**
 * ARC session-run registry.
 *
 * Layout:
 *   ${ARC_PI_HOME:-~/.arc-pi}/session-runs/<session-id>/<run-id>.json
 *
 * Each file is an atomic JSON replacement of one schemaVersion=1 run record.
 * Session IDs and run IDs are validated as single safe path segments; callers
 * without a valid Pi session ID must skip registry writes instead of falling
 * back to a shared bucket.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ArcLiveSnapshot } from "./live-activity.js";
import type { ArcRunnerSessionEvent } from "./runner-events.js";

export const sessionRunSchemaVersion = 1;
export const defaultSessionRunStaleAfterMs = 30_000;

export type SessionRunStatus =
  "running" | "completed" | "failed" | "timed_out" | "cancelled";

/**
 * Whether knownLowerBound reflects the run's full token consumption
 * ("complete"), a partial floor ("lower-bound"), or nothing ("unknown").
 */
export type SessionRunTokenCompleteness =
  "complete" | "lower-bound" | "unknown";

/**
 * Additive W-000225 token accounting on a run record. knownLowerBound is a
 * floor, never an estimate: unknown usage contributes zero. The field is
 * optional so schemaVersion stays at 1 and pre-existing records parse
 * unchanged.
 */
export interface SessionRunTokens {
  knownLowerBound: number;
  completeness: SessionRunTokenCompleteness;
}

export interface SessionRunRef {
  sessionId: string;
  runId: string;
}

export interface SessionRunRecord extends SessionRunRef {
  schemaVersion: typeof sessionRunSchemaVersion;
  label: string;
  mode: string;
  route: string;
  backend: string;
  model: string | null;
  cwd: string;
  status: SessionRunStatus;
  startedAt: string;
  heartbeatAt: string;
  staleAfterMs: number;
  pid?: number;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  tokens?: SessionRunTokens;
  /**
   * Additive delegation-viewer fields. `phase` is the lifecycle phase the
   * worker was launched for, `workloadClass` the approved Implement class,
   * `jobId` the opt-in background job, and `liveActivity` the latest
   * privacy-safe snapshot admitted by ArcLiveActivityConsumer. All optional so
   * schemaVersion stays at 1 and readers without them keep parsing.
   */
  phase?: string;
  workloadClass?: string;
  jobId?: string;
  liveActivity?: ArcLiveSnapshot;
  /**
   * Additive W-000019 bounded, display-safe recent v3 session activity
   * admitted by ArcRunnerSessionEventConsumer. Optional so schemaVersion
   * stays at 1 and older readers (including the monitor TUI) keep parsing.
   */
  sessionActivity?: ArcRunnerSessionEvent[];
}

export interface StartSessionRunInput {
  sessionId: string;
  label: string;
  mode: string;
  route: string;
  backend: string;
  model?: string | null;
  cwd: string;
  pid?: number;
  now?: Date;
  staleAfterMs?: number;
  phase?: string;
  workloadClass?: string;
  jobId?: string;
}

export interface UpdateSessionRunInput {
  model?: string | null;
  pid?: number;
  now?: Date;
  liveActivity?: ArcLiveSnapshot;
  sessionActivity?: ArcRunnerSessionEvent[];
}

export interface EndSessionRunInput extends UpdateSessionRunInput {
  status: Exclude<SessionRunStatus, "running">;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  tokens?: SessionRunTokens;
}

export interface SessionRunStoreOptions {
  arcPiHome?: string;
}

const safePathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const writeQueues = new Map<string, Promise<unknown>>();

export function isSafePathSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    safePathSegmentPattern.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

export function assertSafePathSegment(value: string, name: string): string {
  if (!isSafePathSegment(value)) {
    throw new Error(`${name} must be a safe path segment`);
  }
  return value;
}

export function createSessionRunId(): string {
  return randomUUID();
}

export function resolveArcPiHome(options: SessionRunStoreOptions = {}): string {
  return (
    options.arcPiHome ?? process.env.ARC_PI_HOME ?? join(homedir(), ".arc-pi")
  );
}

export function sessionRunDirectory(
  sessionId: string,
  options: SessionRunStoreOptions = {},
): string {
  return join(
    resolveArcPiHome(options),
    "session-runs",
    assertSafePathSegment(sessionId, "sessionId"),
  );
}

export function sessionRunPath(
  sessionId: string,
  runId: string,
  options: SessionRunStoreOptions = {},
): string {
  return join(
    sessionRunDirectory(sessionId, options),
    `${assertSafePathSegment(runId, "runId")}.json`,
  );
}

export async function startSessionRun(
  input: StartSessionRunInput,
  options: SessionRunStoreOptions = {},
): Promise<SessionRunRecord> {
  const runId = createSessionRunId();
  const now = iso(input.now);
  const record: SessionRunRecord = {
    schemaVersion: sessionRunSchemaVersion,
    sessionId: assertSafePathSegment(input.sessionId, "sessionId"),
    runId,
    label: input.label,
    mode: input.mode,
    route: input.route,
    backend: input.backend,
    model: input.model ?? null,
    cwd: input.cwd,
    status: "running",
    startedAt: now,
    heartbeatAt: now,
    staleAfterMs: input.staleAfterMs ?? defaultSessionRunStaleAfterMs,
    ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.workloadClass ? { workloadClass: input.workloadClass } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
  };
  await replaceSessionRun(record, options);
  return record;
}

export async function updateSessionRunHeartbeat(
  ref: SessionRunRef,
  input: UpdateSessionRunInput = {},
  options: SessionRunStoreOptions = {},
): Promise<SessionRunRecord | undefined> {
  return updateSessionRun(ref, options, (record) => {
    // Terminal records are immutable to heartbeats so late/fire-and-forget
    // updates cannot reopen or rewrite an ended run.
    if (record.status !== "running") return record;
    return {
      ...record,
      heartbeatAt: iso(input.now),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
      ...(input.liveActivity ? { liveActivity: input.liveActivity } : {}),
      ...(input.sessionActivity
        ? { sessionActivity: input.sessionActivity }
        : {}),
    };
  });
}

export async function endSessionRun(
  ref: SessionRunRef,
  input: EndSessionRunInput,
  options: SessionRunStoreOptions = {},
): Promise<SessionRunRecord | undefined> {
  return updateSessionRun(ref, options, (record) => ({
    ...record,
    status: input.status,
    heartbeatAt: iso(input.now),
    endedAt: iso(input.now),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.timedOut !== undefined ? { timedOut: input.timedOut } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.liveActivity ? { liveActivity: input.liveActivity } : {}),
    ...(input.sessionActivity
      ? { sessionActivity: input.sessionActivity }
      : {}),
  }));
}

export async function readSessionRun(
  sessionId: string,
  runId: string,
  options: SessionRunStoreOptions = {},
): Promise<SessionRunRecord | undefined> {
  const file = sessionRunPath(sessionId, runId, options);
  try {
    return parseSessionRunRecord(await readFile(file, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function listSessionRuns(
  sessionId: string,
  options: SessionRunStoreOptions = {},
): Promise<SessionRunRecord[]> {
  const dir = sessionRunDirectory(sessionId, options);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const runId = name.slice(0, -".json".length);
        if (!isSafePathSegment(runId)) return undefined;
        try {
          return await readSessionRun(sessionId, runId, options);
        } catch {
          // Skip corrupt or future-schema files; listing must stay best-effort.
          return undefined;
        }
      }),
  );
  return records
    .filter((record): record is SessionRunRecord => Boolean(record))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function isSessionRunStale(
  record: SessionRunRecord,
  now = Date.now(),
): boolean {
  if (record.status !== "running") return false;
  const heartbeatMs = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  return heartbeatMs + record.staleAfterMs <= now;
}

function updateSessionRun(
  ref: SessionRunRef,
  options: SessionRunStoreOptions,
  update: (record: SessionRunRecord) => SessionRunRecord,
): Promise<SessionRunRecord | undefined> {
  const safeRef = {
    sessionId: assertSafePathSegment(ref.sessionId, "sessionId"),
    runId: assertSafePathSegment(ref.runId, "runId"),
  };
  const key = sessionRunPath(safeRef.sessionId, safeRef.runId, options);
  return enqueueSessionRunWrite(key, async () => {
    const current = await readSessionRun(
      safeRef.sessionId,
      safeRef.runId,
      options,
    );
    if (!current) return undefined;
    const next = update(current);
    await replaceSessionRun(next, options);
    return next;
  });
}

async function replaceSessionRun(
  record: SessionRunRecord,
  options: SessionRunStoreOptions,
): Promise<void> {
  const dir = sessionRunDirectory(record.sessionId, options);
  await mkdir(dir, { recursive: true });
  const target = sessionRunPath(record.sessionId, record.runId, options);
  const temp = join(dir, `.${record.runId}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

function enqueueSessionRunWrite<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // Store a non-rejecting tracked tail so fire-and-forget callers never leave
  // an unhandled rejection, and so Map cleanup compares against the stored value.
  const tracked: Promise<unknown> = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tracked);
  void tracked.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key);
  });
  return next;
}

function parseSessionRunRecord(raw: string): SessionRunRecord {
  const value = JSON.parse(raw) as SessionRunRecord;
  if (value.schemaVersion !== sessionRunSchemaVersion) {
    throw new Error(
      `Unsupported session run schemaVersion: ${value.schemaVersion}`,
    );
  }
  assertSafePathSegment(value.sessionId, "sessionId");
  assertSafePathSegment(value.runId, "runId");
  return value;
}

function iso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

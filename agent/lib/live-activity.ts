export const arcLiveEventPrefix = "arc-orchestrator: event: ";

const maxEventLineChars = 16_000;
const maxEvents = 200;
const maxPhaseHistory = 6;
const maxActivities = 5;
const maxFiles = 20;
const maxDiffs = 5;
const maxDiffHunks = 3;
const maxDiffLines = 24;
const maxDiffLineChars = 200;
const maxDiffHeaderChars = 200;
const maxDiffBytes = 2_400;
const maxDiffBytesPerRun = 8_000;

const phases = new Set([
  "explore",
  "analyze",
  "research",
  "plan",
  "implement",
  "verify",
  "deploy",
  "review",
]);
const phaseStatuses = new Set([
  "preparing",
  "waiting-write-lock",
  "running",
  "validating",
  "completed",
  "blocked",
  "error",
]);
const fileStatuses = new Set([
  "added",
  "modified",
  "deleted",
  "renamed",
  "unknown",
]);
const diffOmissions = new Set([
  "baseline-dirty",
  "binary",
  "malformed-diff",
  "sensitive-path",
  "size-limit",
  "symlink",
  "unsafe-content",
  "unavailable",
]);

export interface ArcLivePhase {
  phase: string;
  status: string;
  model?: string;
}

export interface ArcLiveActivity {
  status: "waiting-provider";
  tool?: string;
  count?: number;
}

export interface ArcLiveFile {
  file: string;
  status: string;
}

export interface ArcLiveFiles {
  count: number;
  files: ArcLiveFile[];
}

export interface ArcLiveDiffHunk {
  header: string;
  lines: string[];
}

export interface ArcLiveDiff {
  file: string;
  status: string;
  oldFile?: string;
  hunks: ArcLiveDiffHunk[];
  truncated: boolean;
  redactions: number;
  omitted?: string;
}

export interface ArcLiveSnapshot {
  v: 1;
  eventsSeen: number;
  phase?: ArcLivePhase;
  phaseHistory: ArcLivePhase[];
  activities: ArcLiveActivity[];
  files?: ArcLiveFiles;
  diffs: ArcLiveDiff[];
}

type ParsedEvent =
  | { kind: "phase"; data: ArcLivePhase }
  | { kind: "activity"; data: ArcLiveActivity }
  | { kind: "files"; data: ArcLiveFiles }
  | { kind: "diff"; data: ArcLiveDiff; bytes: number };

/** One admitted privacy-safe live event, exposed to same-process viewers. */
export type ArcLiveEvent =
  | { kind: "phase"; data: ArcLivePhase }
  | { kind: "activity"; data: ArcLiveActivity }
  | { kind: "files"; data: ArcLiveFiles }
  | { kind: "diff"; data: ArcLiveDiff };

export interface ConsumeArcLiveLineResult {
  handled: boolean;
  accepted: boolean;
  /** Present only when the line was accepted into the snapshot. */
  event?: ArcLiveEvent;
}

/**
 * Strictly consumes the runner's privacy-safe v1 event allowlist and additive
 * v2 unified diffs. Prefix lines are always considered handled, even when
 * malformed, so they never become user-facing failure evidence.
 */
export class ArcLiveActivityConsumer {
  private prefixedLinesSeen = 0;
  private diffBytesSeen = 0;
  private readonly forbiddenText: readonly string[];

  constructor(forbiddenText: readonly string[] = []) {
    this.forbiddenText = forbiddenText.filter((value) => value.length > 0);
  }

  readonly snapshot: ArcLiveSnapshot = {
    v: 1,
    eventsSeen: 0,
    phaseHistory: [],
    activities: [],
    diffs: [],
  };

  consumeLine(line: string): ConsumeArcLiveLineResult {
    if (!line.startsWith(arcLiveEventPrefix)) {
      return { handled: false, accepted: false };
    }
    this.prefixedLinesSeen += 1;
    if (this.prefixedLinesSeen > maxEvents) {
      return { handled: true, accepted: false };
    }
    const payload = line.slice(arcLiveEventPrefix.length);
    if (payload.length === 0 || payload.length > maxEventLineChars) {
      return { handled: true, accepted: false };
    }
    const event = parseEvent(payload);
    if (!event) return { handled: true, accepted: false };
    if (event.kind === "diff") {
      if (
        this.snapshot.diffs.length >= maxDiffs ||
        this.diffBytesSeen + event.bytes > maxDiffBytesPerRun ||
        this.snapshot.diffs.some((diff) => diff.file === event.data.file) ||
        containsForbiddenText(event.data.hunks, this.forbiddenText)
      ) {
        return { handled: true, accepted: false };
      }
      this.diffBytesSeen += event.bytes;
    }

    this.snapshot.eventsSeen += 1;
    if (event.kind === "phase") {
      this.snapshot.phase = event.data;
      const previous = this.snapshot.phaseHistory.at(-1);
      if (
        !previous ||
        previous.phase !== event.data.phase ||
        previous.status !== event.data.status ||
        previous.model !== event.data.model
      ) {
        this.snapshot.phaseHistory.push(event.data);
        this.snapshot.phaseHistory.splice(
          0,
          Math.max(0, this.snapshot.phaseHistory.length - maxPhaseHistory),
        );
      }
    } else if (event.kind === "activity") {
      this.snapshot.activities.push(event.data);
      this.snapshot.activities.splice(
        0,
        Math.max(0, this.snapshot.activities.length - maxActivities),
      );
    } else if (event.kind === "files") {
      // A files event may legally follow a terminal phase event.
      this.snapshot.files = event.data;
    } else {
      // Diff events are additive to v1 and may also follow a terminal phase.
      this.snapshot.diffs.push(event.data);
    }
    return {
      handled: true,
      accepted: true,
      event: { kind: event.kind, data: event.data } as ArcLiveEvent,
    };
  }
}

export function copyArcLiveSnapshot(
  snapshot: ArcLiveSnapshot,
): ArcLiveSnapshot {
  return {
    v: 1,
    eventsSeen: snapshot.eventsSeen,
    ...(snapshot.phase ? { phase: { ...snapshot.phase } } : {}),
    phaseHistory: snapshot.phaseHistory.map((entry) => ({ ...entry })),
    activities: snapshot.activities.map((entry) => ({ ...entry })),
    diffs: snapshot.diffs.map((diff) => ({
      ...diff,
      hunks: diff.hunks.map((hunk) => ({
        header: hunk.header,
        lines: [...hunk.lines],
      })),
    })),
    ...(snapshot.files
      ? {
          files: {
            count: snapshot.files.count,
            files: snapshot.files.files.map((entry) => ({ ...entry })),
          },
        }
      : {}),
  };
}

function parseEvent(payload: string): ParsedEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    !isPositiveSafeInteger(value.seq) ||
    !isNonNegativeSafeInteger(value.at)
  ) {
    return undefined;
  }
  if (!isRecord(value.data)) return undefined;

  if (value.v === 2) {
    if (
      value.kind !== "diff" ||
      !hasOnlyKeys(value, ["v", "kind", "seq", "at", "data"])
    ) {
      return undefined;
    }
    const data = parseDiffData(value.data);
    if (!data) return undefined;
    return { kind: "diff", data, bytes: Buffer.byteLength(payload) };
  }

  if (value.v !== 1) return undefined;

  if (value.kind === "phase") {
    const phase = boundedToken(value.data.phase, 40);
    const status = boundedToken(value.data.status, 40);
    const model = optionalLabel(value.data.model, 80);
    if (!phase || !phases.has(phase) || !status || !phaseStatuses.has(status)) {
      return undefined;
    }
    if (value.data.model !== undefined && !model) return undefined;
    return {
      kind: "phase",
      data: { phase, status, ...(model ? { model } : {}) },
    };
  }

  if (value.kind === "activity") {
    if (value.data.status !== "waiting-provider") return undefined;
    const tool = optionalLabel(value.data.tool, 40);
    const count = optionalCount(value.data.count);
    if (value.data.tool !== undefined && !tool) return undefined;
    if (value.data.count !== undefined && count === undefined) return undefined;
    return {
      kind: "activity",
      data: {
        status: "waiting-provider",
        ...(tool ? { tool } : {}),
        ...(count !== undefined ? { count } : {}),
      },
    };
  }

  if (value.kind === "files") {
    if (!isNonNegativeSafeInteger(value.data.count)) return undefined;
    if (
      !Array.isArray(value.data.files) ||
      value.data.files.length > maxFiles
    ) {
      return undefined;
    }
    const files: ArcLiveFile[] = [];
    for (const entry of value.data.files) {
      if (!isRecord(entry)) return undefined;
      const file = safeRepoRelativePath(entry.file);
      if (
        !file ||
        typeof entry.status !== "string" ||
        !fileStatuses.has(entry.status)
      ) {
        return undefined;
      }
      if (sensitivePath(file)) continue;
      files.push({ file, status: entry.status });
    }
    if (value.data.count < files.length) return undefined;
    return {
      kind: "files",
      data: { count: value.data.count, files },
    };
  }
  return undefined;
}

function parseDiffData(data: Record<string, unknown>): ArcLiveDiff | undefined {
  if (
    !hasOnlyKeys(data, [
      "file",
      "status",
      "oldFile",
      "hunks",
      "truncated",
      "redactions",
      "omitted",
    ])
  ) {
    return undefined;
  }
  const file = safeRepoRelativePath(data.file);
  const oldFile =
    data.oldFile === undefined ? undefined : safeRepoRelativePath(data.oldFile);
  if (
    !file ||
    typeof data.status !== "string" ||
    !fileStatuses.has(data.status) ||
    (data.oldFile !== undefined && !oldFile) ||
    typeof data.truncated !== "boolean" ||
    !isNonNegativeSafeInteger(data.redactions) ||
    !Array.isArray(data.hunks) ||
    data.hunks.length > maxDiffHunks
  ) {
    return undefined;
  }
  const omitted = data.omitted;
  if (
    omitted !== undefined &&
    (typeof omitted !== "string" || !diffOmissions.has(omitted))
  ) {
    return undefined;
  }
  if (
    sensitivePath(file) ||
    (oldFile !== undefined && sensitivePath(oldFile))
  ) {
    return undefined;
  }

  let lineCount = 0;
  const hunks: ArcLiveDiffHunk[] = [];
  for (const value of data.hunks) {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["header", "lines"]) ||
      typeof value.header !== "string" ||
      !safeDiffHunkHeader(value.header) ||
      !Array.isArray(value.lines)
    ) {
      return undefined;
    }
    const lines: string[] = [];
    for (const line of value.lines) {
      lineCount += 1;
      if (
        lineCount > maxDiffLines ||
        typeof line !== "string" ||
        line.length > maxDiffLineChars ||
        Buffer.byteLength(line) > maxDiffLineChars ||
        !/^[ +\\-]/u.test(line) ||
        /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(line)
      ) {
        return undefined;
      }
      lines.push(line);
    }
    hunks.push({ header: value.header, lines });
  }

  if (
    (omitted !== undefined && hunks.length > 0) ||
    Buffer.byteLength(JSON.stringify(data)) > maxDiffBytes ||
    (omitted === undefined && unsafeDiffContent(hunks))
  ) {
    return undefined;
  }

  return {
    file,
    status: data.status,
    ...(oldFile ? { oldFile } : {}),
    hunks,
    truncated: data.truncated,
    redactions: data.redactions,
    ...(omitted ? { omitted } : {}),
  };
}

function safeDiffHunkHeader(value: string): boolean {
  return (
    value.length <= maxDiffHeaderChars &&
    Buffer.byteLength(value) <= maxDiffHeaderChars &&
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: [^\u0000-\u001f\u007f]+)?$/u.test(
      value,
    )
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function sensitivePath(path: string): boolean {
  return path
    .toLowerCase()
    .split("/")
    .some(
      (part) =>
        part === ".env" ||
        part.startsWith(".env.") ||
        part === ".npmrc" ||
        part === ".pypirc" ||
        part === ".netrc" ||
        part === "credentials" ||
        part === "credentials.json" ||
        part === "id_rsa" ||
        part === "id_ed25519" ||
        part === ".aws" ||
        part === ".ssh" ||
        part === ".gnupg" ||
        part === ".claude" ||
        part === ".codex" ||
        /\.(?:key|pem|p12|pfx|log)$/iu.test(part) ||
        /(^|[._-])(prompt|transcript|conversation)([._-]|$)/u.test(part) ||
        /(^|[._-])(credentials?|secrets?|passwords?|tokens?|api[-_]?keys?|access[-_]?keys?|private[-_]?keys?)([._-]|$)/u.test(
          part,
        ),
    );
}

const secretLike =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"']{6,}|\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/iu;
const rawTranscriptLike =
  /^[-+ ]?\s*"(?:assistant|reasoning|prompt|system|tool_calls?)"\s*:/iu;

function unsafeDiffContent(hunks: ArcLiveDiffHunk[]): boolean {
  return hunks.some((hunk) =>
    [hunk.header.slice(hunk.header.indexOf("@@", 2) + 2).trim(), ...hunk.lines]
      .filter((value) => value.length > 0)
      .some((value) => secretLike.test(value) || rawTranscriptLike.test(value)),
  );
}

function containsForbiddenText(
  hunks: ArcLiveDiffHunk[],
  forbiddenText: readonly string[],
): boolean {
  if (forbiddenText.length === 0) return false;
  const content = hunks
    .flatMap((hunk) => [hunk.header, ...hunk.lines])
    .join("\n");
  return forbiddenText.some((value) => content.includes(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalCount(value: unknown): number | undefined {
  return value === undefined || !isNonNegativeSafeInteger(value)
    ? undefined
    : value;
}

function boundedToken(value: unknown, maxChars: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars
  ) {
    return undefined;
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function optionalLabel(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const label = boundedToken(value, maxChars);
  return label && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/u.test(label)
    ? label
    : undefined;
}

function safeRepoRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return undefined;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

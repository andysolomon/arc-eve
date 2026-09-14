/**
 * W-000019 v3 runner session-activity protocol.
 *
 * The external runner may emit a versioned stream of allowlisted, display-safe
 * assistant and tool activity on stderr, using the same
 * `arc-orchestrator: event: ` prefix as the v1/v2 live events:
 *
 *   { v: 3, kind: "session", seq, at, data: { type: "assistant", text } }
 *   { v: 3, kind: "session", seq, at, data: { type: "tool-start" | "tool-update" | "tool-end",
 *       tool, callId?, detail?, ok? } }
 *
 * Everything is strictly validated and fails closed: unknown versions and
 * kinds fall through to the v1 consumer, and malformed v3 payloads are
 * consumed and dropped. Text is bounded and rejected outright when it carries
 * terminal controls, secret-like values, absolute or home filesystem paths,
 * or any excerpt of the delegation contract. Provider-private reasoning has
 * no admitted event type. Older runners that never emit v3 events keep the
 * existing phase/activity summaries unchanged.
 */
import { arcLiveEventPrefix } from "./live-activity.js";

const maxEventLineChars = 16_000;
const maxSessionEvents = 300;
const maxAssistantChars = 2_000;
const maxToolDetailChars = 400;
const maxRecentEvents = 20;

export const arcRunnerSessionEventTypes = [
  "assistant",
  "tool-start",
  "tool-update",
  "tool-end",
] as const;

export type ArcRunnerSessionEventType =
  (typeof arcRunnerSessionEventTypes)[number];

/** One admitted, display-safe session-activity event. */
export interface ArcRunnerSessionEvent {
  type: ArcRunnerSessionEventType;
  text: string;
  tool?: string;
  callId?: string;
  ok?: boolean;
}

export interface ConsumeRunnerSessionLineResult {
  handled: boolean;
  accepted: boolean;
  /** Present only when the line was accepted. */
  event?: ArcRunnerSessionEvent;
}

const secretLikePattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"']{6,}|\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/iu;

const unsafePathPattern =
  /(?:^|[\s"'`=:(])(?:~\/|\/(?:home|users|root|var|etc|tmp|private|opt|srv|mnt)\/)|[A-Za-z]:\\/iu;

const controlCharPattern = /[\u0000-\u001f\u007f-\u009f]/u;

const toolLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,39}$/u;
const callIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class ArcRunnerSessionEventConsumer {
  private v3LinesSeen = 0;
  private readonly forbiddenText: readonly string[];

  /** Total accepted v3 session events. */
  eventsSeen = 0;

  /** Bounded ring of the most recent accepted events, oldest first. */
  readonly recent: ArcRunnerSessionEvent[] = [];

  constructor(forbiddenText: readonly string[] = []) {
    this.forbiddenText = forbiddenText.filter((value) => value.length > 0);
  }

  consumeLine(line: string): ConsumeRunnerSessionLineResult {
    if (!line.startsWith(arcLiveEventPrefix)) {
      return { handled: false, accepted: false };
    }
    const payload = line.slice(arcLiveEventPrefix.length);
    if (payload.length === 0 || payload.length > maxEventLineChars) {
      return { handled: false, accepted: false };
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return { handled: false, accepted: false };
    }
    if (!isRecord(value) || value.v !== 3) {
      // Not a v3 line; leave it to the v1/v2 live-activity consumer.
      return { handled: false, accepted: false };
    }
    // From here the line belongs to this protocol version and is always
    // handled: malformed v3 payloads are consumed and dropped, never surfaced
    // as user-facing failure evidence.
    this.v3LinesSeen += 1;
    if (this.v3LinesSeen > maxSessionEvents) {
      return { handled: true, accepted: false };
    }
    const event = this.parseEvent(value);
    if (!event) return { handled: true, accepted: false };
    this.eventsSeen += 1;
    this.recent.push(event);
    this.recent.splice(0, Math.max(0, this.recent.length - maxRecentEvents));
    return { handled: true, accepted: true, event: { ...event } };
  }

  private parseEvent(
    value: Record<string, unknown>,
  ): ArcRunnerSessionEvent | undefined {
    if (
      !hasOnlyKeys(value, ["v", "kind", "seq", "at", "data"]) ||
      value.kind !== "session" ||
      !isPositiveSafeInteger(value.seq) ||
      !isNonNegativeSafeInteger(value.at) ||
      !isRecord(value.data)
    ) {
      return undefined;
    }
    const data = value.data;
    const type = data.type;
    if (
      typeof type !== "string" ||
      !(arcRunnerSessionEventTypes as readonly string[]).includes(type)
    ) {
      return undefined;
    }

    if (type === "assistant") {
      if (!hasOnlyKeys(data, ["type", "text"])) return undefined;
      const text = this.safeDisplayText(data.text, maxAssistantChars);
      if (!text) return undefined;
      return { type, text };
    }

    if (!hasOnlyKeys(data, ["type", "tool", "callId", "detail", "ok"])) {
      return undefined;
    }
    const tool =
      typeof data.tool === "string" && toolLabelPattern.test(data.tool)
        ? data.tool
        : undefined;
    if (!tool) return undefined;
    if (data.ok !== undefined) {
      if (type !== "tool-end" || typeof data.ok !== "boolean") return undefined;
    }
    let callId: string | undefined;
    if (data.callId !== undefined) {
      if (typeof data.callId !== "string" || !callIdPattern.test(data.callId)) {
        return undefined;
      }
      callId = data.callId;
    }
    let detail = "";
    if (data.detail !== undefined) {
      const safeDetail = this.safeDisplayText(data.detail, maxToolDetailChars);
      if (safeDetail === undefined) return undefined;
      detail = safeDetail;
    }
    return {
      type: type as ArcRunnerSessionEventType,
      text: detail || defaultToolText(type, tool, data.ok as boolean),
      tool,
      ...(callId ? { callId } : {}),
      ...(data.ok !== undefined ? { ok: data.ok as boolean } : {}),
    };
  }

  /**
   * Admits only bounded text free of terminal controls, secret-like values,
   * absolute/home paths, and delegation-contract excerpts. Returns undefined
   * when the value must be rejected.
   */
  private safeDisplayText(
    value: unknown,
    maxChars: number,
  ): string | undefined {
    if (typeof value !== "string" || value.length === 0) return undefined;
    if (value.length > maxChars || Buffer.byteLength(value) > maxChars * 4) {
      return undefined;
    }
    if (
      controlCharPattern.test(value) ||
      secretLikePattern.test(value) ||
      unsafePathPattern.test(value)
    ) {
      return undefined;
    }
    if (this.forbiddenText.some((forbidden) => value.includes(forbidden))) {
      return undefined;
    }
    return value;
  }
}

function defaultToolText(
  type: string,
  tool: string,
  ok: boolean | undefined,
): string {
  if (type === "tool-start") return `${tool} started`;
  if (type === "tool-update") return `${tool} updated`;
  return `${tool} ${ok === false ? "failed" : "completed"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

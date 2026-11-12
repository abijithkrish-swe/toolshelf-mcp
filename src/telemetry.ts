// OpenTelemetry for toolshelf: traces of each `run`, and an event per blocked
// command, sent as OTLP/HTTP JSON to a local collector (SigNoz).
//
// Hand-written instead of the OTel SDK: toolshelf needs ~4 span kinds and one
// event type, and the SDK would add dozens of packages to a security tool.
//
// - Endpoint: TOOLSHELF_OTLP_ENDPOINT (default http://127.0.0.1:4318);
//   "off" turns telemetry off. Uses node:http directly, so it never goes
//   through the proxy.
// - Never throws and never delays a tool result: exports are fire-and-forget
//   with a short timeout. With no collector running, the data is dropped.
// - Commands are recorded (like Claude Code's tool details and Codex's tool
//   arguments); command OUTPUT never is. It stays in the run log on disk.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";

export type AttrValue = string | number | boolean | undefined | null;
export type Attrs = Record<string, AttrValue>;

const VERSION = "2.0.0";
const EXPORT_TIMEOUT_MS = 2_000;
const MAX_ATTR_CHARS = 1_024;

/** The OTLP/HTTP base URL, or null when telemetry is off. */
export function endpoint(): string | null {
  const v = (process.env.TOOLSHELF_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").trim();
  if (/^(off|none|0|false)?$/i.test(v)) return null;
  return v.replace(/\/+$/, "");
}

// --- time: wall clock at load + monotonic offsets, in nanoseconds -------------

const WALL_BASE = BigInt(Date.now()) * 1_000_000n;
const MONO_BASE = process.hrtime.bigint();
const nowNs = () => WALL_BASE + (process.hrtime.bigint() - MONO_BASE);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

// --- resource: who is sending -------------------------------------------------

const resource: Attrs = {
  "service.name": "toolshelf",
  "service.version": VERSION,
};

/**
 * The MCP client (claude-code, codex-mcp-client, cursor, claude-ai …), from the
 * MCP initialize handshake. For Claude Code, also `agent.config`, the same
 * claude/myclaude label Claude Code's own telemetry uses: taken from the
 * CLAUDE_CONFIG_DIR the client started us with.
 */
export function setClient(name?: string, version?: string): void {
  if (name) resource["agent.client"] = name;
  if (version) resource["agent.client.version"] = version;
  if (name && /claude-code/i.test(name)) {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    resource["agent.config"] = !dir ? "claude" : basename(dir) === "claude-personal" ? "myclaude" : basename(dir);
  }
}

/** The program a command starts with, for grouping: `cd x && FOO=1 mvn -q test` → mvn. */
export function commandName(command: string): string {
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const w = part.trim().split(/\s+/).find((x) => !/^\w+=/.test(x));
    if (!w || w === "cd" || w === "export" || w === "set") continue;
    return basename(w).slice(0, 64);
  }
  return "";
}

// --- spans ----------------------------------------------------------------------

export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  start: bigint;
  end: bigint;
  attrs: Attrs;
  status?: { code: 1 | 2; message?: string };
}

interface LogRecord {
  time: bigint;
  severity: { number: number; text: string };
  body: string;
  attrs: Attrs;
  traceId?: string;
  spanId?: string;
}

const pendingSpans: FinishedSpan[] = [];
const pendingLogs: LogRecord[] = [];

export class Span {
  readonly traceId: string;
  readonly spanId = hex(8);
  private readonly start = nowNs();
  private attrs: Attrs = {};
  private status?: { code: 1 | 2; message?: string };
  private done = false;

  constructor(
    readonly name: string,
    private readonly parentSpanId?: string,
    traceId?: string,
    private readonly kind: number = SpanKind.INTERNAL,
  ) {
    this.traceId = traceId ?? hex(16);
  }

  child(name: string, kind: number = SpanKind.INTERNAL): Span {
    return new Span(name, this.spanId, this.traceId, kind);
  }

  set(attrs: Attrs): this {
    Object.assign(this.attrs, attrs);
    return this;
  }

  ok(): this {
    this.status = { code: 1 };
    return this;
  }

  error(message: string): this {
    this.status = { code: 2, message: message.slice(0, MAX_ATTR_CHARS) };
    return this;
  }

  /** Record an event (a log record) linked to this span. */
  event(name: string, body: string, attrs: Attrs = {}, severity = { number: 13, text: "WARN" }): this {
    pendingLogs.push({
      time: nowNs(),
      severity,
      body,
      attrs: { "event.name": name, ...attrs },
      traceId: this.traceId,
      spanId: this.spanId,
    });
    return this;
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    pendingSpans.push({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      start: this.start,
      end: nowNs(),
      attrs: this.attrs,
      status: this.status,
    });
  }

  /** Run fn inside a child span; the child ends (with an error status on throw). */
  async within<T>(name: string, fn: (s: Span) => Promise<T> | T): Promise<T> {
    const s = this.child(name);
    try {
      return await fn(s);
    } catch (err) {
      s.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      s.end();
    }
  }
}

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/;

/**
 * Start a root span. With a W3C `traceparent` from the client (MCP `_meta`),
 * the span joins the agent's own trace, under its tool-call span.
 */
export function startSpan(name: string, traceparent?: unknown): Span {
  const m = typeof traceparent === "string" ? TRACEPARENT.exec(traceparent.trim()) : null;
  if (m && !/^0+$/.test(m[1]) && !/^0+$/.test(m[2])) return new Span(name, m[2], m[1], SpanKind.SERVER);
  return new Span(name, undefined, undefined, SpanKind.SERVER);
}

// --- OTLP/HTTP JSON encoding ----------------------------------------------------

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function otlpValue(v: Exclude<AttrValue, undefined | null>): OtlpValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v.length > MAX_ATTR_CHARS ? `${v.slice(0, MAX_ATTR_CHARS)}…` : v };
}

export function otlpAttrs(attrs: Attrs): { key: string; value: OtlpValue }[] {
  return Object.entries(attrs)
    .filter((e): e is [string, Exclude<AttrValue, undefined | null>] => e[1] !== undefined && e[1] !== null)
    .map(([key, v]) => ({ key, value: otlpValue(v) }));
}

const scope = { name: "toolshelf", version: VERSION };

export function encodeTraces(spans: FinishedSpan[]): object {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttrs(resource) },
        scopeSpans: [
          {
            scope,
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: String(s.start),
              endTimeUnixNano: String(s.end),
              attributes: otlpAttrs(s.attrs),
              ...(s.status ? { status: s.status } : {}),
            })),
          },
        ],
      },
    ],
  };
}

export function encodeLogs(logs: LogRecord[]): object {
  return {
    resourceLogs: [
      {
        resource: { attributes: otlpAttrs(resource) },
        scopeLogs: [
          {
            scope,
            logRecords: logs.map((l) => ({
              timeUnixNano: String(l.time),
              observedTimeUnixNano: String(l.time),
              severityNumber: l.severity.number,
              severityText: l.severity.text,
              body: { stringValue: l.body },
              attributes: otlpAttrs(l.attrs),
              ...(l.traceId ? { traceId: l.traceId, spanId: l.spanId } : {}),
            })),
          },
        ],
      },
    ],
  };
}

// --- export -----------------------------------------------------------------------

function post(url: string, body: object): Promise<void> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve();
    }
    const data = JSON.stringify(body);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        timeout: EXPORT_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve());
    req.end(data);
  });
}

/**
 * Send everything recorded so far. Always resolves; callers don't await it on
 * the request path (`void flush()`), tests do.
 */
export async function flush(): Promise<void> {
  const base = endpoint();
  const spans = pendingSpans.splice(0);
  const logs = pendingLogs.splice(0);
  if (!base) return;
  await Promise.all([
    spans.length ? post(`${base}/v1/traces`, encodeTraces(spans)) : undefined,
    logs.length ? post(`${base}/v1/logs`, encodeLogs(logs)) : undefined,
  ]);
}

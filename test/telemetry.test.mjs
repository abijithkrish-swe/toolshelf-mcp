// Telemetry: what toolshelf sends over OTLP/HTTP JSON, checked with a local
// receiver (never the user's collector).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DIST, IN_SANDBOX, makeProject, setupHome } from "./helpers.mjs";

const env = setupHome();
const project = makeProject(env.home, "app");
const BREW = ["br", "ew"].join("") + " install";

const { commandName, endpoint, startSpan, otlpAttrs } = await import(join(DIST, "telemetry.js"));

// --- a fake OTLP receiver -----------------------------------------------------
const received = { traces: [], logs: [] };
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/traces") received.traces.push(JSON.parse(body));
    if (req.url === "/v1/logs") received.logs.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
let client;

before(async () => {
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${receiver.address().port}`;
  client = new Client({ name: "claude-code", version: "9.9.9" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, "index.js")],
      env: { ...process.env, TOOLSHELF_OTLP_ENDPOINT: url, CLAUDE_CONFIG_DIR: join(env.home, ".config", "claude-personal") },
    }),
  );
});
after(async () => {
  await client?.close();
  receiver.close();
  env.cleanup();
});

/** Wait until the receiver has `n` trace exports. */
async function waitTraces(n) {
  for (let i = 0; i < 100 && received.traces.length < n; i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(received.traces.length >= n, `expected ${n} trace exports, got ${received.traces.length}`);
}
const spansOf = (exp) => exp.resourceSpans[0].scopeSpans[0].spans;
const attr = (list, key) => {
  const v = list.find((a) => a.key === key)?.value;
  return v && (v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue);
};

// --- unit ---------------------------------------------------------------------

test("commandName: the program, skipping cd, exports and VAR=value", () => {
  assert.equal(commandName("cd x && FOO=1 /usr/bin/mvn -q test"), "mvn");
  assert.equal(commandName("export A=1; pnpm install && pnpm test"), "pnpm");
  assert.equal(commandName("  ./gradlew build"), "gradlew");
  assert.equal(commandName("cd x"), "");
});

test("endpoint: default local, 'off' disables", () => {
  const saved = process.env.TOOLSHELF_OTLP_ENDPOINT;
  try {
    delete process.env.TOOLSHELF_OTLP_ENDPOINT;
    assert.equal(endpoint(), "http://127.0.0.1:4318");
    process.env.TOOLSHELF_OTLP_ENDPOINT = "http://127.0.0.1:9/";
    assert.equal(endpoint(), "http://127.0.0.1:9");
    for (const off of ["off", "none", "0", ""]) {
      process.env.TOOLSHELF_OTLP_ENDPOINT = off;
      assert.equal(endpoint(), null, off);
    }
  } finally {
    process.env.TOOLSHELF_OTLP_ENDPOINT = saved;
  }
});

test("startSpan joins a valid traceparent, ignores bad or all-zero ones", () => {
  const tid = "4bf92f3577b34da6a3ce929d0e0e4736";
  const s = startSpan("x", `00-${tid}-00f067aa0ba902b7-01`);
  assert.equal(s.traceId, tid);
  for (const bad of [undefined, 42, "garbage", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`]) {
    const o = startSpan("x", bad);
    assert.match(o.traceId, /^[\da-f]{32}$/);
    assert.notEqual(o.traceId, tid);
  }
});

test("otlpAttrs: types, drops empty values, caps long strings", () => {
  const a = otlpAttrs({ s: "x", i: 3, d: 1.5, b: false, u: undefined, n: null, long: "y".repeat(5000) });
  assert.deepEqual(a.slice(0, 4), [
    { key: "s", value: { stringValue: "x" } },
    { key: "i", value: { intValue: "3" } },
    { key: "d", value: { doubleValue: 1.5 } },
    { key: "b", value: { boolValue: false } },
  ]);
  assert.equal(a.length, 5);
  assert.ok(a[4].value.stringValue.length <= 1025);
});

// --- over MCP -----------------------------------------------------------------

test("a blocked run: an error span, a toolshelf.blocked event, client labels", async () => {
  const before = received.traces.length;
  const r = await client.callTool({ name: "run", arguments: { command: `cd x && ${BREW} jq`, cwd: project } });
  assert.equal(r.isError, true);
  await waitTraces(before + 1);

  const exp = received.traces.at(-1);
  const res = exp.resourceSpans[0].resource.attributes;
  assert.equal(attr(res, "service.name"), "toolshelf");
  assert.equal(attr(res, "agent.client"), "claude-code");
  assert.equal(attr(res, "agent.config"), "myclaude", "label from CLAUDE_CONFIG_DIR, like Claude Code's own");

  const spans = spansOf(exp);
  const root = spans.find((s) => s.name === "toolshelf.run");
  const check = spans.find((s) => s.name === "toolshelf.check");
  assert.ok(root && check);
  assert.equal(check.parentSpanId, root.spanId);
  assert.equal(root.status.code, 2);
  assert.equal(attr(root.attributes, "toolshelf.blocked"), true);
  assert.equal(attr(root.attributes, "toolshelf.command.name"), "brew");
  assert.equal(attr(root.attributes, "toolshelf.project"), "app");

  for (let i = 0; i < 100 && !received.logs.length; i++) await new Promise((r) => setTimeout(r, 30));
  const rec = received.logs.at(-1).resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(attr(rec.attributes, "event.name"), "toolshelf.blocked");
  assert.match(attr(rec.attributes, "toolshelf.block_reason"), /Homebrew/);
  assert.equal(rec.traceId, root.traceId);
});

test("a run joins the caller's trace via _meta.traceparent", async () => {
  const tid = "0af7651916cd43dd8448eb211c80319c";
  const parent = "b7ad6b7169203331";
  const before = received.traces.length;
  await client.callTool({
    name: "run",
    arguments: { command: "true", cwd: project, network: "proxy" }, // fails fast: network is docker-only
    _meta: { traceparent: `00-${tid}-${parent}-01` },
  });
  await waitTraces(before + 1);
  const root = spansOf(received.traces.at(-1)).find((s) => s.name === "toolshelf.run");
  assert.equal(root.traceId, tid);
  assert.equal(root.parentSpanId, parent);
  assert.equal(root.kind, 2);
});

const skip = IN_SANDBOX ? "sandbox-exec can't nest inside toolshelf's sandbox" : false;

test("a sandboxed run: check → prepare → exec, exit code, no output", { skip }, async () => {
  const before = received.traces.length;
  const r = await client.callTool({
    name: "run",
    arguments: { command: "fake secret-looking-output; exit 3", cwd: project, tools: { fake: "" } },
  });
  assert.equal(r.isError, true);
  await waitTraces(before + 1);
  const spans = spansOf(received.traces.at(-1));
  const root = spans.find((s) => s.name === "toolshelf.run");
  for (const n of ["toolshelf.check", "sandbox.prepare", "sandbox.exec"]) {
    const s = spans.find((x) => x.name === n);
    assert.ok(s, `missing span ${n}`);
    assert.equal(s.parentSpanId, root.spanId, n);
    assert.ok(BigInt(s.startTimeUnixNano) >= BigInt(root.startTimeUnixNano), `${n} starts inside the run`);
    assert.ok(BigInt(s.endTimeUnixNano) <= BigInt(root.endTimeUnixNano), `${n} ends inside the run`);
  }
  assert.equal(attr(root.attributes, "process.exit.code"), "3");
  assert.equal(attr(root.attributes, "toolshelf.tools"), "fake 1.2.3");
  assert.equal(attr(root.attributes, "toolshelf.mode"), "sandbox");
  assert.equal(root.status.code, 2);
  // The command is recorded; its output never is.
  assert.doesNotMatch(JSON.stringify(received.traces.at(-1)), /fake 1\.2\.3 secret-looking-output/);
});

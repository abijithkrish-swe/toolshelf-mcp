// End to end over MCP: start dist/index.js as an agent would (stdio) and call tools.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DIST, IN_SANDBOX, MANIFEST, makeProject, setupHome } from "./helpers.mjs";

const env = setupHome();
const project = makeProject(env.home, "app");
const BREW = ["br", "ew"].join("") + " install";
let client;

before(async () => {
  client = new Client({ name: "toolshelf-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(DIST, "index.js")], env: { ...process.env } }),
  );
});
after(async () => {
  await client?.close();
  env.cleanup();
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: Boolean(r.isError), text: r.content.map((c) => c.text ?? "").join("\n") };
};

test("exposes the expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["list_components", "get_component_versions", "get_defaults", "get_component_env",
    "resolve_toolsrc", "run", "request_component", "colima_status"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  const run = tools.find((t) => t.name === "run");
  assert.match(run.description, /not to edit files/);
  assert.match(JSON.stringify(run.inputSchema), /TMPDIR/);
});

test("sends the agent rules as server instructions", () => {
  const text = client.getInstructions();
  assert.ok(text, "no instructions in the initialize result");
  for (const rule of [/Never install, upgrade or remove/, /request_component/, /mode "docker"/,
    /network "proxy"/, /not for editing files/, /\$TMPDIR/, /Never read or print secrets/]) {
    assert.match(text, rule);
  }
  assert.ok(text.length < 1500, `instructions are sent every session; keep them short (${text.length} chars)`);
});

test("list_components shows only the manifest's tools", async () => {
  const r = await call("list_components");
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^fake: 1\.2\.3 \(default\), 1\.2\.10, 25\.0\.1$/m, "only approved, healthy versions are offered");
  assert.match(r.text, /! broken 2\.0\.0-rc-1: missing on disk/);
  assert.match(r.text, /\? on disk but not approved: 3\.0/);
  assert.match(r.text, /^other: 1\.0 \(default, docker\)$/m);
});

test("get_component_env returns exports for approved versions only", async () => {
  const ok = await call("get_component_env", { tools: { fake: "25" } });
  assert.equal(ok.error, false, ok.text);
  assert.match(ok.text, /FAKE_HOME=.*Fake\/25\.0\.1/);
  const bad = await call("get_component_env", { tools: { fake: "3.0" } });
  assert.equal(bad.error, true);
  assert.match(bad.text, /not approved/);
});

test("the manifest is re-read on every call, and a bad one is reported", async () => {
  writeFileSync(env.manifestPath, MANIFEST + "@bogus\n");
  try {
    const r = await call("list_components");
    assert.equal(r.error, true);
    assert.match(r.text, /unknown directive @bogus/);
  } finally {
    writeFileSync(env.manifestPath, MANIFEST);
  }
  assert.equal((await call("list_components")).error, false);
});

test("run refuses blocklisted commands and logs the attempt", async () => {
  const r = await call("run", { command: `echo hi && ${BREW} jq`, cwd: project });
  assert.equal(r.error, true);
  assert.match(r.text, /^Blocked: Homebrew changes system tools/);
  const rec = JSON.parse(readFileSync(join(env.state, "blocked.jsonl"), "utf-8").trim().split("\n").pop());
  assert.equal(rec.source, "run");
  assert.equal(rec.cwd, project);
});

test("run: network applies to docker mode only", async () => {
  const r = await call("run", { command: "true", cwd: project, network: "proxy" });
  assert.equal(r.error, true);
  assert.match(r.text, /network applies only to mode "docker"/);
});

test("request_component records a request and never installs", async () => {
  const r = await call("request_component", { tool: "fake", version: "4.0", reason: "needs new API", project });
  assert.equal(r.error, false, r.text);
  const rec = JSON.parse(readFileSync(join(env.state, "requests.jsonl"), "utf-8").trim());
  assert.equal(rec.tool, "fake");
  assert.equal(rec.version, "4.0");
  assert.ok(!existsSync(join(env.components, "Fake", "4.0")));
});

const skip = IN_SANDBOX ? "sandbox-exec can't nest inside toolshelf's sandbox" : false;

test("run: a sandboxed command end to end", { skip }, async () => {
  const r = await call("run", { command: "fake hi", cwd: project, tools: { fake: "" } });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^exit 0 in /);
  assert.match(r.text, /tools: fake 1\.2\.3 \[tools argument\]/);
  assert.match(r.text, /fake 1\.2\.3 hi/);
  assert.doesNotMatch(r.text, /sandbox blocked/);
});

test("run: notes a sandbox refusal even when the exit code is 0", { skip }, async () => {
  const r = await call("run", { command: "echo x > /tmp/ts-$$ 2>/dev/null; true", cwd: project, tools: {} });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /note: the sandbox blocked a file operation/);
});

test("run: a non-zero exit is an error result", { skip }, async () => {
  const r = await call("run", { command: "exit 4", cwd: project, tools: {} });
  assert.equal(r.error, true);
  assert.match(r.text, /^exit 4 in /);
});

// scripts/register.mjs: Claude app (JSON) and Codex (TOML) registration.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "./helpers.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const { claudeApp, codex } = await import(`${SCRIPTS}/register.mjs`);

let home;
const homes = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "toolshelf-register-")));
  homes.push(home);
  put(join(home, "exists.js"), ""); // a server script that is really there
});
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const opts = (extra = {}) => ({
  node: "/C/Node/20/bin/node",
  server: "/C/toolshelf-mcp/dist/index.js",
  components: "/C",
  manifest: "/cfg/components.conf",
  dryRun: false,
  removeStale: false,
  ...extra,
});
const run = (fn, o = opts()) => {
  const out = [];
  fn(home, o, out);
  return out;
};
const appPath = () => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
const tomlPath = () => join(home, ".codex", "config.toml");
const backups = (p) => readdirSync(dirname(p)).filter((f) => f.startsWith(`${p.split("/").pop()}.bak-`));
const WANT_APP = {
  command: "/C/Node/20/bin/node",
  args: ["/C/toolshelf-mcp/dist/index.js"],
  env: { COMPONENTS: "/C", COMPONENTS_MANIFEST: "/cfg/components.conf" },
};

// --- Claude app ---------------------------------------------------------------

test("Claude app: not installed → nothing written", () => {
  assert.match(run(claudeApp)[0], /^Claude app: not installed/);
});

test("Claude app: adds toolshelf, keeps every other key, backs up first", () => {
  put(appPath(), JSON.stringify({ coworkUserFilesPath: "/x", preferences: { theme: "dark" } }));
  assert.match(run(claudeApp)[0], /^Claude app: added toolshelf/);
  const cfg = JSON.parse(readFileSync(appPath(), "utf-8"));
  assert.deepEqual(cfg.mcpServers.toolshelf, WANT_APP);
  assert.equal(cfg.coworkUserFilesPath, "/x");
  assert.deepEqual(cfg.preferences, { theme: "dark" });
  assert.equal(backups(appPath()).length, 1);
});

test("Claude app: second run is up to date and writes nothing", () => {
  put(appPath(), JSON.stringify({ preferences: {} }));
  run(claudeApp);
  const before = readFileSync(appPath(), "utf-8");
  assert.match(run(claudeApp)[0], /^Claude app: up to date/);
  assert.equal(readFileSync(appPath(), "utf-8"), before);
  assert.equal(backups(appPath()).length, 1);
});

test("Claude app: a hand-made entry that differs is updated; other servers kept", () => {
  put(appPath(), JSON.stringify({
    mcpServers: { toolshelf: { command: "node", args: ["/old.js"] }, other: { command: "npx", args: ["some-server"] } },
  }));
  assert.match(run(claudeApp)[0], /^Claude app: updated toolshelf/);
  const cfg = JSON.parse(readFileSync(appPath(), "utf-8"));
  assert.deepEqual(cfg.mcpServers.toolshelf, WANT_APP);
  assert.deepEqual(cfg.mcpServers.other, { command: "npx", args: ["some-server"] });
});

test("Claude app: stale servers are reported, and removed only when asked", () => {
  const live = join(home, "live.js");
  writeFileSync(live, "");
  put(appPath(), JSON.stringify({
    mcpServers: {
      "my-components": { command: "node", args: [join(home, "gone", "MyComponentsMCP", "dist", "index.js")] },
      alive: { command: "node", args: [live] },
    },
  }));
  const out = run(claudeApp);
  assert.ok(out.some((l) => /^stale: Claude app my-components: .*MyComponentsMCP.* no longer exists$/.test(l)), out.join("\n"));
  assert.ok(JSON.parse(readFileSync(appPath(), "utf-8")).mcpServers["my-components"], "not removed without the flag");

  const out2 = run(claudeApp, opts({ removeStale: true }));
  assert.match(out2.join("\n"), /removed stale my-components/);
  const cfg = JSON.parse(readFileSync(appPath(), "utf-8"));
  assert.equal(cfg.mcpServers["my-components"], undefined);
  assert.ok(cfg.mcpServers.alive);
});

test("Claude app: dry run writes nothing", () => {
  put(appPath(), "{}");
  assert.match(run(claudeApp, opts({ dryRun: true }))[0], /added toolshelf .*\[dry run\]/);
  assert.equal(readFileSync(appPath(), "utf-8"), "{}");
  assert.equal(backups(appPath()).length, 0);
});

// --- Codex ----------------------------------------------------------------------

const codexText = () => `# my codex settings
model = "gpt-x"
notify = ["say", "done"]

[features]
multi_agent = true

[mcp_servers.node_repl]
command = "/usr/local/bin/node"
args = ["${home}/exists.js"]
startup_timeout_sec = 30

[mcp_servers.node_repl.env]
CODEX_HOME = "/h"

[projects."/Users/me/Projects/App"]
trust_level = "trusted"
`;
const OURS = `[mcp_servers.toolshelf]
command = "/C/Node/20/bin/node"
args = ["/C/toolshelf-mcp/dist/index.js"]
env = { COMPONENTS = "/C", COMPONENTS_MANIFEST = "/cfg/components.conf" }
`;

test("Codex: not installed → nothing written", () => {
  assert.match(run(codex)[0], /^Codex: not installed/);
});

test("Codex: appends toolshelf; everything before it stays byte for byte", () => {
  put(tomlPath(), codexText());
  assert.match(run(codex)[0], /^Codex: added toolshelf/);
  assert.equal(readFileSync(tomlPath(), "utf-8"), codexText() + "\n" + OURS);
  assert.equal(backups(tomlPath()).length, 1);
});

test("Codex: second run is up to date and writes nothing", () => {
  put(tomlPath(), codexText());
  run(codex);
  assert.match(run(codex)[0], /^Codex: up to date/);
  assert.equal(backups(tomlPath()).length, 1);
});

test("Codex: replaces an existing toolshelf block in place, sub-tables included", () => {
  const old = codexText().replace("[projects.", `[mcp_servers.toolshelf]\ncommand = "node"\nargs = ["/old.js"]\n\n[mcp_servers.toolshelf.env]\nX = "1"\n\n[projects.`);
  put(tomlPath(), old);
  assert.match(run(codex)[0], /^Codex: updated toolshelf/);
  const text = readFileSync(tomlPath(), "utf-8");
  assert.equal(text, codexText().replace("[projects.", OURS + "\n[projects."));
  assert.doesNotMatch(text, /old\.js|toolshelf\.env/);
});

test("Codex: stale servers reported; removed with the flag; others untouched", () => {
  put(tomlPath(), codexText().replace("[features]", `[mcp_servers.dev-env]\ncommand = "node"\nargs = ["${home}/Components/MyComponentsMCP/dist/index.js"]\n\n[features]`));
  const out = run(codex);
  assert.ok(out.some((l) => /^stale: Codex dev-env: .*MyComponentsMCP.*no longer exists$/.test(l)), out.join("\n"));
  assert.match(readFileSync(tomlPath(), "utf-8"), /dev-env/, "not removed without the flag");

  run(codex, opts({ removeStale: true }));
  const text = readFileSync(tomlPath(), "utf-8");
  assert.doesNotMatch(text, /dev-env|MyComponentsMCP/);
  assert.match(text, /\[mcp_servers\.node_repl\]\ncommand = "\/usr\/local\/bin\/node"/, "a server whose script isn't a missing .js is kept");
  assert.match(text, /^# my codex settings\nmodel = "gpt-x"/);
});

test("Codex: quoted server names and a file that starts with a header", () => {
  put(tomlPath(), `[mcp_servers."my server"]\ncommand = "x"\n`);
  run(codex);
  assert.equal(readFileSync(tomlPath(), "utf-8"), `[mcp_servers."my server"]\ncommand = "x"\n\n${OURS}`);
});

test("Codex: paths with spaces and quotes are escaped", () => {
  put(tomlPath(), "");
  run(codex, opts({ server: '/Users/me/My "Tools"/index.js' }));
  assert.match(readFileSync(tomlPath(), "utf-8"), /args = \["\/Users\/me\/My \\"Tools\\"\/index\.js"\]/);
});

test("Codex: dry run writes nothing", () => {
  put(tomlPath(), codexText());
  assert.match(run(codex, opts({ dryRun: true }))[0], /\[dry run\]/);
  assert.equal(readFileSync(tomlPath(), "utf-8"), codexText());
  assert.equal(backups(tomlPath()).length, 0);
});

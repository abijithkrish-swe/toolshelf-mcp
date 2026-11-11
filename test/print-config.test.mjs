// install.sh --print-config: the by-hand registration instructions must be
// correct for this machine's paths (they're pasted into other apps' configs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { put, setupHome } from "./helpers.mjs";

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const env = setupHome({
  manifest: `@tool node dir=Node check=node\nnode 20.19.5 default\n`,
});
after(env.cleanup);

// A manifest-default node that really runs (install.sh uses it to build the JSON)
const nodeBin = join(env.components, "Node", "20.19.5", "bin");
mkdirSync(nodeBin, { recursive: true });
symlinkSync(process.execPath, join(nodeBin, "node"));
const prefix = join(env.components, "My Tools", "toolshelf-mcp"); // a space, on purpose
const server = join(prefix, "dist", "index.js");

const out = execFileSync("sh", [INSTALL, "--print-config", "--components", env.components,
  "--manifest", env.manifestPath, "--prefix", prefix], { encoding: "utf-8", env: { ...process.env, PATH: "/usr/bin:/bin" } });

/** The JSON blocks (lines from "{" to "}" at column 0). */
const blocks = [...out.matchAll(/^\{\n[\s\S]*?\n\}$/gm)].map((m) => JSON.parse(m[0]));

test("prints instructions for Codex, the Claude app and Cursor, and nothing is installed", () => {
  assert.match(out, /^Codex — /m);
  assert.match(out, /^Claude app \(Chat \/ Cowork\) — merge into "mcpServers"/m);
  assert.match(out, /Application Support\/Claude\/claude_desktop_config\.json/);
  assert.match(out, /^Cursor — merge into "mcpServers" in ~\/\.cursor\/mcp\.json/m);
  assert.match(out, /MyComponentsMCP/);
  assert.doesNotMatch(out, /==> Installing/);
});

test("the JSON blocks are valid and point at this machine's paths", () => {
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.deepEqual(b, {
      mcpServers: {
        toolshelf: {
          command: join(nodeBin, "node"),
          args: [server],
          env: { COMPONENTS: env.components, COMPONENTS_MANIFEST: env.manifestPath },
        },
      },
    });
  }
});

test("the Codex command is quoted for paths with spaces and silences the first remove", () => {
  const line = out.split("\n").find((l) => l.includes(" mcp add toolshelf "));
  assert.ok(line, out);
  assert.ok(line.includes(`mcp remove toolshelf >/dev/null 2>&1;`));
  assert.ok(line.includes(`--env 'COMPONENTS=${env.components}'`));
  assert.ok(line.includes(`--env 'COMPONENTS_MANIFEST=${env.manifestPath}'`));
  assert.ok(line.endsWith(`-- '${join(nodeBin, "node")}' '${server}'`), line);
});

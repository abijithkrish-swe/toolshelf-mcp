#!/usr/bin/env node
// register.mjs — register toolshelf in the MCP clients that have no CLI for it:
//   Claude app   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Codex        ~/.codex/config.toml  (Codex CLI and the Codex part of the ChatGPT app)
// Claude Code is registered by install.sh through `claude mcp add`.
//
//   node register.mjs --node N --server S --components C --manifest M
//                     [--dry-run] [--remove-stale]
//
// Only the toolshelf entry is written; everything else in each file is kept as
// is. Codex's TOML is edited as text, so comments and order survive. Each file
// is backed up (<file>.bak-<timestamp>) before a write, and left alone when it's
// already up to date. Stale entries (servers whose script or command no longer
// exists, e.g. the old MyComponentsMCP) are reported, and removed only with
// --remove-stale. Lines starting with "stale:" are for install.sh to parse.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const NAME = "toolshelf";

function parseArgs(argv) {
  const o = { dryRun: false, removeStale: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--remove-stale") o.removeStale = true;
    else if (["--node", "--server", "--components", "--manifest"].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ["node", "server", "components", "manifest"]) {
    if (!o[k]) throw new Error(`--${k} is required`);
  }
  return o;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

function backupAndWrite(path, text, o) {
  if (o.dryRun) return;
  copyFileSync(path, `${path}.bak-${stamp()}`);
  writeFileSync(path, text);
}

/** Why an entry is stale, or "" — a script argument or absolute command that no longer exists. */
function staleReason(strings) {
  for (const s of strings) {
    if (typeof s !== "string" || !isAbsolute(s)) continue;
    if (/\.(c|m)?js$|\.py$|\.ts$/.test(s) && !existsSync(s)) return `${s} no longer exists`;
  }
  return "";
}

// --- Claude app (JSON) --------------------------------------------------------

export function claudeApp(home, o, out) {
  const path = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (!existsSync(path)) return out.push(`Claude app: not installed (no ${path})`);
  const raw = readFileSync(path, "utf-8");
  const cfg = raw.trim() ? JSON.parse(raw) : {};
  cfg.mcpServers ??= {};
  const servers = cfg.mcpServers;

  const removed = [];
  for (const [name, s] of Object.entries(servers)) {
    if (name === NAME) continue;
    const why = staleReason([s?.command, ...(Array.isArray(s?.args) ? s.args : [])]);
    if (!why) continue;
    if (o.removeStale) {
      delete servers[name];
      removed.push(name);
    } else out.push(`stale: Claude app ${name}: ${why}`);
  }

  const want = {
    command: o.node,
    args: [o.server],
    env: { COMPONENTS: o.components, COMPONENTS_MANIFEST: o.manifest },
  };
  const had = servers[NAME];
  const same = had && JSON.stringify(had) === JSON.stringify(want);
  if (!same) servers[NAME] = want;
  if (same && !removed.length) return out.push(`Claude app: up to date (${path})`);
  backupAndWrite(path, JSON.stringify(cfg, null, 2) + "\n", o);
  out.push(
    `Claude app: ${same ? "kept" : had ? "updated" : "added"} ${NAME}` +
      (removed.length ? `; removed stale ${removed.join(", ")}` : "") +
      ` (${path})${o.dryRun ? " [dry run]" : ""}`,
  );
}

// --- Codex (TOML, edited as text) --------------------------------------------

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const q = (s) => JSON.stringify(s); // TOML basic strings share JSON's escapes for paths

/** Split TOML text into [{name, lines}] blocks; the first block (name "") is the top-level table. */
function blocks(text) {
  const out = [{ name: "", lines: [] }];
  for (const line of text.split("\n")) {
    const m = line.match(HEADER);
    if (m) out.push({ name: m[1].replace(/\s+/g, ""), lines: [line] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}
/** "mcp_servers.x" and its sub-tables ("mcp_servers.x.env") → "x"; else undefined. */
function serverOf(name) {
  const m = name.match(/^mcp_servers\.("([^"]+)"|[A-Za-z0-9_-]+)(\.|$)/);
  return m ? (m[2] ?? m[1]) : undefined;
}

export function codex(home, o, out) {
  const path = join(home, ".codex", "config.toml");
  if (!existsSync(path)) return out.push(`Codex: not installed (no ${path})`);
  const text = readFileSync(path, "utf-8");
  const bs = blocks(text);

  const ours = [
    `[mcp_servers.${NAME}]`,
    `command = ${q(o.node)}`,
    `args = [${q(o.server)}]`,
    `env = { COMPONENTS = ${q(o.components)}, COMPONENTS_MANIFEST = ${q(o.manifest)} }`,
    "",
  ];

  // Stale servers: all quoted strings in their blocks
  const removed = [];
  const byServer = new Map();
  for (const b of bs) {
    const s = serverOf(b.name);
    if (s && s !== NAME) byServer.set(s, [...(byServer.get(s) ?? []), b]);
  }
  const drop = new Set();
  for (const [s, group] of byServer) {
    const strings = group.flatMap((b) => [...b.lines.join("\n").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
    const why = staleReason(strings);
    if (!why) continue;
    if (o.removeStale) {
      group.forEach((b) => drop.add(b));
      removed.push(s);
    } else out.push(`stale: Codex ${s}: ${why}`);
  }

  // Replace our block family in place, or append it
  const result = [];
  let placed = false;
  for (const b of bs) {
    if (drop.has(b)) continue;
    if (serverOf(b.name) === NAME) {
      if (!placed) result.push({ name: b.name, lines: ours });
      placed = true;
      continue;
    }
    result.push(b);
  }
  if (!placed) {
    const last = result[result.length - 1];
    while (last.lines.length && last.lines[last.lines.length - 1].trim() === "") last.lines.pop();
    last.lines.push("");
    result.push({ name: `mcp_servers.${NAME}`, lines: ours });
  }
  // (an empty top-level block, when the file starts with a header, must not add a blank line)
  let next = result
    .filter((b, i) => !(i === 0 && b.name === "" && b.lines.length === 0))
    .map((b) => b.lines.join("\n"))
    .join("\n");

  if (next === text) return out.push(`Codex: up to date (${path})`);
  if (!next.endsWith("\n")) next += "\n";
  const had = bs.some((b) => serverOf(b.name) === NAME);
  backupAndWrite(path, next, o);
  out.push(
    `Codex: ${had ? "updated" : "added"} ${NAME}` +
      (removed.length ? `; removed stale ${removed.join(", ")}` : "") +
      ` (${path})${o.dryRun ? " [dry run]" : ""}`,
  );
}

// --- main ----------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const out = [];
    claudeApp(homedir(), o, out);
    codex(homedir(), o, out);
    console.log(out.join("\n"));
  } catch (err) {
    console.error(`register.mjs: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

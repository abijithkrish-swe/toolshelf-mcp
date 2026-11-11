#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  loadManifest,
  findTool,
  versionsOf,
  locate,
  unlistedOnDisk,
  envFor,
  resolveVersion,
  type Manifest,
  type VersionEntry,
} from "./components.js";
import { loadBlocklist, matchBlocklist, recordBlocked } from "./blocklist.js";
import { readToolsrc } from "./toolsrc.js";
import { DEFAULT_TAIL_KB, runSandboxed, sandboxDenied, validateProject } from "./sandbox.js";
import { runDocker } from "./docker.js";
import { REQUESTS_PATH } from "./paths.js";
import { INSTRUCTIONS } from "./instructions.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "toolshelf",
    version: "2.0.0",
  },
  // The rules reach every client this way, even ones that never load AGENTS.md
  { instructions: INSTRUCTIONS },
);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/** Load the manifest fresh and run fn; any error becomes an MCP error result. */
function withManifest(fn: (m: Manifest) => ToolResult): ToolResult {
  try {
    return fn(loadManifest());
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function flags(v: VersionEntry): string {
  const f = [
    v.isDefault && "default",
    v.autoload && "autoload",
    v.onPath && "onpath",
    v.docker && "docker",
  ].filter(Boolean);
  return f.length ? ` (${f.join(", ")})` : "";
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Tool: list_components
// ---------------------------------------------------------------------------

server.tool(
  "list_components",
  "List the approved developer components and versions from the user's manifest, " +
    "with on-disk health. Only these versions may be used. Never install or upgrade " +
    "tools yourself — ask the user.",
  async () =>
    withManifest((m) => {
      const lines: string[] = [];
      for (const tool of m.tools) {
        const versions = versionsOf(m, tool);
        const extra = unlistedOnDisk(m, tool);
        if (versions.length === 0 && extra.length === 0) continue;

        const ok: string[] = [];
        const broken: string[] = [];
        for (const v of versions) {
          const loc = locate(tool, v.version);
          if ("problem" in loc) broken.push(`${v.version}: ${loc.problem}`);
          else ok.push(v.version + flags(v));
        }
        lines.push(`${tool.name}: ${ok.join(", ") || "(none usable)"}`);
        for (const b of broken) lines.push(`  ! broken ${b}`);
        if (extra.length) lines.push(`  ? on disk but not approved: ${extra.join(", ")}`);
      }
      return text(lines.join("\n") || `No components in ${m.path}.`);
    }),
);

// ---------------------------------------------------------------------------
// Tool: get_component_versions
// ---------------------------------------------------------------------------

server.tool(
  "get_component_versions",
  "List approved versions for one component (e.g. jdk, maven, node, go, redis, mysql).",
  { tool: z.string().describe("Component name, e.g. jdk, maven, gradle, node, go, python, redis, mysql") },
  async ({ tool }) =>
    withManifest((m) => {
      const def = findTool(m, tool);
      if (!def) {
        return fail(`Unknown component "${tool}". Available: ${m.tools.map((t) => t.name).join(", ")}`);
      }
      const versions = versionsOf(m, def);
      if (versions.length === 0) return text(`No approved ${def.name} versions.`);
      return text(`${def.name}: ${versions.map((v) => v.version + flags(v)).join(", ")}`);
    }),
);

// ---------------------------------------------------------------------------
// Tool: get_defaults
// ---------------------------------------------------------------------------

server.tool(
  "get_defaults",
  "Show default component versions (used when no version is given). " +
    "'autoload' ones are also activated in the user's interactive login shell; " +
    "'onpath' ones only have their binaries on the login PATH (not activated). " +
    "Agent shells get none of these: use get_component_env.",
  async () =>
    withManifest((m) => {
      const lines = m.versions
        .filter((v) => v.isDefault || v.autoload || v.onPath)
        .map((v) => `${v.tool}: ${v.version}${flags(v)}`);
      return text(lines.join("\n") || "No defaults configured.");
    }),
);

// ---------------------------------------------------------------------------
// Tool: get_component_env
// ---------------------------------------------------------------------------

server.tool(
  "get_component_env",
  "Get shell exports (JAVA_HOME, PATH, ...) that activate approved component versions. " +
    "Prefix your shell command with them, e.g. `<exports> && mvn -v`. " +
    "Use this instead of the user's use_* shell functions, which don't work in agent shells. " +
    "Each command runs in a fresh shell, so include the exports every time.",
  {
    tools: z
      .record(z.string(), z.string())
      .describe('Map of component → version, e.g. {"jdk": "17", "maven": ""}. Empty version = default.'),
  },
  async ({ tools }) =>
    withManifest((m) => {
      const env = envFor(m, tools);
      const exports = env.vars.map(([k, v]) => `export ${k}=${shq(v)}`);
      if (env.path.length) exports.push(`export PATH=${shq(env.path.join(":"))}:"$PATH"`);
      const picked = env.selected.map((s) => `${s.tool} ${s.version}`).join(", ");
      return text(`# ${picked}\n${exports.join("\n")}`);
    }),
);

// ---------------------------------------------------------------------------
// Tool: resolve_toolsrc
// ---------------------------------------------------------------------------

server.tool(
  "resolve_toolsrc",
  "Read a project's .toolsrc (the versions it pins) and return the matching shell exports " +
    "plus the `tools` map to pass to `run`. Prefer this over guessing versions.",
  { dir: z.string().describe("Project directory containing .toolsrc") },
  async ({ dir }) =>
    withManifest((m) => {
      const project = validateProject(dir);
      const rc = readToolsrc(project);
      if (!rc) return text(`No .toolsrc in ${project}. Use get_defaults / get_component_env instead.`);
      const env = envFor(m, rc.tools);
      const exports = env.vars.map(([k, v]) => `export ${k}=${shq(v)}`);
      if (env.path.length) exports.push(`export PATH=${shq(env.path.join(":"))}:"$PATH"`);
      const notes = [
        rc.shellOnly.length && `# not applied (shell-only, run toolup yourself): ${rc.shellOnly.join(", ")}`,
        rc.unknown.length && `# unknown keys ignored: ${rc.unknown.join(", ")}`,
      ].filter(Boolean);
      const tools = Object.fromEntries(env.selected.map((s) => [s.tool, s.version]));
      return text(
        [
          `# ${rc.path}: ${env.selected.map((s) => `${s.tool} ${s.version}`).join(", ") || "(no tools)"}`,
          ...notes,
          ...exports,
          "",
          `tools for run: ${JSON.stringify(tools)}`,
        ].join("\n"),
      );
    }),
);

// ---------------------------------------------------------------------------
// Tool: run
// ---------------------------------------------------------------------------

server.tool(
  "run",
  "Run a shell command in a macOS sandbox with approved component versions. " +
    "Writes are limited to the project dir and sandbox-only caches; network goes only through " +
    "the local proxy; credentials, shell history and ~/Library are unreadable; the environment " +
    "is minimal (no inherited secrets). Installing or upgrading tools is blocked. " +
    "If `tools` is omitted, the project's .toolsrc is used (if any). Returns exit code, " +
    "the last ~8 KB of output and a full log path (read the log for more). Prefer quiet build " +
    "flags (mvn -q, gradle -q, npm --silent, cargo -q) and one `run` for a multi-step task. " +
    "Use `run` for builds, tests and scripts, not to edit files (use your edit tools), and don't " +
    "pipe output through tail/head (use tail_kb).",
  {
    command: z
      .string()
      .describe(
        "Shell command, run with zsh -c in the project dir. Temp files go in $TMPDIR (private to this " +
          "run, deleted after); /tmp is not writable in the sandbox.",
      ),
    cwd: z.string().describe("Project directory (absolute or ~/...), at least two levels under $HOME"),
    tools: z
      .record(z.string(), z.string())
      .optional()
      .describe('Components to activate, e.g. {"jdk": "17", "maven": ""}. Omit to use .toolsrc.'),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Kill the command after this many seconds (default 600)"),
    tail_kb: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(`KB of output to return, from the end (default ${DEFAULT_TAIL_KB}). The full log is always saved.`),
    mode: z
      .enum(["sandbox", "docker"])
      .optional()
      .describe(
        'sandbox (default): macOS sandbox with the approved host tools. docker: for untrusted code — ' +
          "a throwaway container from the one requested tool's pinned image, project mounted at /work, " +
          "nothing else from the host. Needs Colima running.",
      ),
    network: z
      .enum(["none", "proxy"])
      .optional()
      .describe(
        'docker mode only. none (default): no network. proxy: only the zero-trust proxy is reachable ' +
          "(enforced), e.g. to download dependencies.",
      ),
  },
  async ({ command, cwd, tools, timeout_seconds, tail_kb, mode, network }) => {
    let m: Manifest;
    try {
      m = loadManifest();
      if (network && mode !== "docker") return fail('network applies only to mode "docker"');
      // Docker runs are isolated from the host's tools, so the blocklist
      // (which protects them) applies to sandbox mode only.
      const rule = mode === "docker" ? undefined : matchBlocklist(loadBlocklist(), command);
      if (rule) {
        recordBlocked(rule, command, cwd);
        return fail(
          `Blocked: ${rule.reason}.\nThis command was not run. If the user wants it, they run it ` +
            `themselves; for a missing tool version use request_component.`,
        );
      }
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    let selection = tools;
    let source = "tools argument";
    if (!selection) {
      try {
        const rc = readToolsrc(validateProject(cwd));
        selection = rc?.tools ?? {};
        source = rc ? rc.path : "no .toolsrc (system tools only)";
      } catch (err: unknown) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    try {
      const base = {
        command,
        cwd,
        tools: selection,
        timeoutSec: timeout_seconds ?? 600,
        tailChars: (tail_kb ?? DEFAULT_TAIL_KB) * 1024,
      };
      const r =
        mode === "docker"
          ? await runDocker(m, { ...base, network: network ?? "none" })
          : await runSandboxed(m, base);
      if (mode === "docker") source += `; docker, network ${network ?? "none"}`;
      const status = r.timedOut
        ? `TIMED OUT after ${timeout_seconds ?? 600}s`
        : r.exitCode !== null
          ? `exit ${r.exitCode}`
          : `killed by ${r.signal}`;
      const header = [
        `${status} in ${(r.durationMs / 1000).toFixed(1)}s`,
        `tools: ${r.selected.map((s) => `${s.tool} ${s.version}`).join(", ") || "(none)"} [${source}]`,
        `log: ${r.logPath}`,
        r.truncated
          ? `(showing the last ${tail_kb ?? DEFAULT_TAIL_KB} KB; read the log for the rest, or pass a larger tail_kb)`
          : "",
        mode !== "docker" && sandboxDenied(r.logPath)
          ? "note: the sandbox blocked a file operation (\"operation not permitted\" in the log), even if " +
            "the exit code looks fine. Writes are allowed only in the project and $TMPDIR (not /tmp, not ~)."
          : "",
      ].filter(Boolean);
      const result = { content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${r.tail}` }] };
      return r.exitCode === 0 ? result : { ...result, isError: true };
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: request_component
// ---------------------------------------------------------------------------

server.tool(
  "request_component",
  "Ask the user to approve/install a component version that isn't in the manifest. " +
    "This only records the request (the user reviews it with `components_requests`); it never " +
    "installs anything. Tell the user you made the request.",
  {
    tool: z.string().describe("Component name, e.g. jdk, node, python (may be a new tool type)"),
    version: z.string().describe("Version needed, e.g. 21 or 3.12.4"),
    reason: z.string().describe("Why it is needed (project, error message, requirement)"),
    project: z.string().optional().describe("Project directory it is for"),
  },
  async ({ tool, version, reason, project }) =>
    withManifest((m) => {
      const def = findTool(m, tool);
      if (def) {
        try {
          const v = resolveVersion(m, def, version);
          return text(`${def.name} ${v.version} is already approved; use it via get_component_env or run.`);
        } catch {
          /* not approved — record the request */
        }
      }
      mkdirSync(dirname(REQUESTS_PATH), { recursive: true });
      const entry = { ts: new Date().toISOString(), tool, version, reason, project: project ?? null };
      appendFileSync(REQUESTS_PATH, JSON.stringify(entry) + "\n");
      return text(
        `Recorded request: ${tool} ${version}. It is NOT installed. Tell the user; they review ` +
          `requests with \`components_requests\` and decide.`,
      );
    }),
);

// ---------------------------------------------------------------------------
// Tool: colima_status
// ---------------------------------------------------------------------------

server.tool(
  "colima_status",
  "Show Colima/Docker status: VM state, Docker context, Kubernetes context, and running containers.",
  async () => {
    // Each command runs directly and in parallel (no interactive zsh per call).
    const [status, list, context, kube, ps] = await Promise.all([
      cmd("colima", ["status"]),
      cmd("colima", ["list"]),
      cmd("docker", ["context", "show"]),
      cmd("kubectl", ["config", "current-context"]),
      cmd("docker", ["ps", "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}"]),
    ]);
    const sections = [
      `Colima:\n${status.ok ? colimaMsgs(status.out) : `not running (${colimaMsgs(status.out) || "colima not found"})`}`,
      ...(list.out ? [`Instances:\n${list.out}`] : []),
      `Docker context: ${context.ok ? context.out : "none"}`,
      `Kubernetes context: ${kube.ok ? kube.out : "none"}`,
      `Containers:\n${ps.ok ? ps.out : "Docker not reachable"}`,
    ];
    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: colima_start
// ---------------------------------------------------------------------------

server.tool(
  "colima_start",
  "Start Colima VM with Docker and Kubernetes. Returns the shell command to run.",
  {
    kubernetes: z.boolean().optional().describe("Include --kubernetes flag (default: true, matching user's costart alias)"),
  },
  async ({ kubernetes }) => {
    const k8s = kubernetes !== false;
    const command = k8s ? "colima start --kubernetes" : "colima start";
    return {
      content: [{
        type: "text",
        text: `Run this command in the terminal:\n\n${command}\n\nThis will start the Colima VM with Docker${k8s ? " and Kubernetes" : ""} runtime.`,
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: colima_stop
// ---------------------------------------------------------------------------

server.tool(
  "colima_stop",
  "Stop Colima VM. Returns the shell command to run.",
  async () => {
    return {
      content: [{
        type: "text",
        text: "Run this command in the terminal:\n\ncolima stop\n\nThis will stop the Colima VM and Docker/Kubernetes runtime.",
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: colima_restart
// ---------------------------------------------------------------------------

server.tool(
  "colima_restart",
  "Restart Colima VM. Returns the shell command to run.",
  async () => {
    return {
      content: [{
        type: "text",
        text: "Run this command in the terminal:\n\ncolima restart\n\nThis will restart the Colima VM.",
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: colima_delete
// ---------------------------------------------------------------------------

server.tool(
  "colima_delete",
  "Delete the Colima VM entirely (all images and volumes inside are lost). Returns the shell command to run.",
  async () => {
    return {
      content: [{
        type: "text",
        text: "Run this command in the terminal:\n\ncolima delete -f\n\n⚠️  This will DESTROY the Colima VM. All Docker images and volumes inside are lost.",
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: docker_context_use_colima
// ---------------------------------------------------------------------------

server.tool(
  "docker_context_use_colima",
  "Switch Docker CLI to use the Colima context. Returns the shell command to run.",
  async () => {
    return {
      content: [{
        type: "text",
        text: "Run this command in the terminal:\n\ndocker context use colima\n\nThis ensures the Docker CLI targets the Colima runtime.",
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// colima logs as `time=… level=info msg="…"`; keep just the messages
function colimaMsgs(s: string): string {
  return s.replace(/^.*?msg="(.*)"\s*$/gm, "  $1");
}

// ---------------------------------------------------------------------------
// Helper: run a CLI directly (PATH + Homebrew), output = stdout+stderr
// ---------------------------------------------------------------------------

async function cmd(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 10_000, env: { ...process.env, PATH } });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

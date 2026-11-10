#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  loadManifest,
  findTool,
  versionsOf,
  locate,
  unlistedOnDisk,
  envFor,
  type Manifest,
  type VersionEntry,
} from "./components.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "toolshelf",
  version: "2.0.0",
});

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
  const f = [v.isDefault && "default", v.autoload && "autoload", v.docker && "docker"].filter(Boolean);
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
    "'autoload' ones are also activated in the user's interactive login shell.",
  async () =>
    withManifest((m) => {
      const lines = m.versions
        .filter((v) => v.isDefault || v.autoload)
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
// Tool: colima_status
// ---------------------------------------------------------------------------

server.tool(
  "colima_status",
  "Show Colima/Docker status: VM state, Docker context, Kubernetes context, and running containers.",
  async () => {
    const sections: string[] = [];

    // Colima VM status
    try {
      const { stdout } = await runZsh("colima status 2>&1");
      sections.push(`Colima:\n${stdout.trim()}`);
    } catch {
      sections.push("Colima: not running");
    }

    // Colima instances
    try {
      const { stdout } = await runZsh("colima list 2>&1");
      sections.push(`Instances:\n${stdout.trim()}`);
    } catch {
      // ignore
    }

    // Docker context
    try {
      const { stdout } = await runZsh("docker context show 2>&1");
      sections.push(`Docker context: ${stdout.trim()}`);
    } catch {
      sections.push("Docker context: none");
    }

    // Kubernetes context
    try {
      const { stdout } = await runZsh("kubectl config current-context 2>&1");
      sections.push(`Kubernetes context: ${stdout.trim()}`);
    } catch {
      sections.push("Kubernetes context: none");
    }

    // Running containers
    try {
      const { stdout } = await runZsh("docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>&1");
      sections.push(`Containers:\n${stdout.trim()}`);
    } catch {
      sections.push("Containers: Docker not reachable");
    }

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
// Helper: run a command in the user's zsh
// ---------------------------------------------------------------------------

async function runZsh(command: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("/bin/zsh", ["-i", "-c", command], {
    timeout: 10_000,
    env: { ...process.env, HOME: process.env.HOME },
  });
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

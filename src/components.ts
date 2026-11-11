import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Manifest — the approved list of components (components.conf)
//
// Only what the manifest lists exists for agents. It is re-read on every call,
// so editing it needs no rebuild or restart. Format: see components.conf.
// ---------------------------------------------------------------------------

export interface ToolDef {
  /** Manifest name (e.g. "jdk") */
  name: string;
  /** Directory name under ~/Components/ */
  dir: string;
  /** Candidate tool-home subpaths inside a version folder; first existing wins */
  root: string[];
  /** Candidate bin dirs relative to the tool home; first containing `check` wins */
  bin: string[];
  /** Binary that must exist in the bin dir for a version to be healthy */
  check?: string;
  /** Env vars set to the tool home when active */
  homeEnv: string[];
}

export interface VersionEntry {
  tool: string;
  version: string;
  isDefault: boolean;
  autoload: boolean;
  /** Bin dir put on PATH at login without activating the tool (e.g. a client) */
  onPath: boolean;
  /** Pinned image (image@sha256:...) for docker mode */
  docker?: string;
}

export interface Manifest {
  path: string;
  tools: ToolDef[];
  versions: VersionEntry[];
  /** Helper images from `@image <name> <image@sha256:…>` lines (e.g. the docker-mode proxy forwarder) */
  images: Record<string, string>;
}

export class ManifestError extends Error {}

export const COMPONENTS_ROOT = process.env.COMPONENTS || join(homedir(), "Components");

export function manifestPath(): string {
  return (
    process.env.COMPONENTS_MANIFEST ||
    join(homedir(), ".config", "components", "components.conf")
  );
}

const TOOL_KEYS = new Set(["dir", "root", "bin", "check", "home"]);

/** A Docker image reference pinned by digest — the only kind docker mode will run. */
export const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

/** Parse components.conf. Throws ManifestError (with line numbers) on any problem. */
export function loadManifest(): Manifest {
  const path = manifestPath();
  if (!existsSync(path)) {
    throw new ManifestError(
      `Manifest not found at ${path}. Deploy it with \`install_copy.sh deploy\` ` +
        `or set COMPONENTS_MANIFEST.`,
    );
  }

  const tools: ToolDef[] = [];
  const versions: VersionEntry[] = [];
  const images: Record<string, string> = {};
  const errors: string[] = [];

  readFileSync(path, "utf-8")
    .split("\n")
    .forEach((raw, i) => {
      // \r first: "." doesn't match it, so a CRLF comment would survive /#.*$/
      const line = raw.replace(/\r$/, "").replace(/#.*$/, "").trim();
      if (!line) return;
      const where = `line ${i + 1}`;
      const [head, ...rest] = line.split(/\s+/);

      if (head === "@tool") {
        const [name, ...pairs] = rest;
        if (!name) return errors.push(`${where}: @tool needs a name`);
        const kv: Record<string, string> = {};
        for (const p of pairs) {
          const eq = p.indexOf("=");
          const key = eq > 0 ? p.slice(0, eq) : "";
          if (!TOOL_KEYS.has(key)) return errors.push(`${where}: unknown @tool key "${p}"`);
          kv[key] = p.slice(eq + 1);
        }
        if (!kv.dir) return errors.push(`${where}: @tool ${name} needs dir=`);
        if (tools.some((t) => t.name === name)) {
          return errors.push(`${where}: duplicate @tool ${name}`);
        }
        tools.push({
          name,
          dir: kv.dir,
          root: (kv.root ?? ".").split("|"),
          bin: (kv.bin ?? "bin").split("|"),
          check: kv.check,
          homeEnv: kv.home ? kv.home.split(",") : [],
        });
        return;
      }

      if (head === "@image") {
        const [name, ref] = rest;
        if (!name || !ref) return errors.push(`${where}: @image needs a name and an image`);
        if (!PINNED_IMAGE.test(ref)) {
          return errors.push(`${where}: @image ${name} must be pinned by digest (image@sha256:<64 hex>)`);
        }
        images[name] = ref;
        return;
      }

      if (head.startsWith("@")) return errors.push(`${where}: unknown directive ${head}`);

      // Version line: <tool> <version> [flags]
      const tool = tools.find((t) => t.name === head);
      if (!tool) return errors.push(`${where}: version for undefined tool "${head}"`);
      const [version, ...flags] = rest;
      if (!version) return errors.push(`${where}: missing version`);
      if (versions.some((v) => v.tool === head && v.version === version)) {
        return errors.push(`${where}: duplicate ${head} ${version}`);
      }
      const entry: VersionEntry = { tool: head, version, isDefault: false, autoload: false, onPath: false };
      for (const f of flags) {
        if (f === "default") entry.isDefault = true;
        else if (f === "autoload") entry.autoload = true;
        else if (f === "onpath") entry.onPath = true;
        else if (f.startsWith("docker=")) {
          entry.docker = f.slice("docker=".length);
          if (!PINNED_IMAGE.test(entry.docker)) {
            errors.push(`${where}: docker image must be pinned by digest (image@sha256:<64 hex>)`);
          }
        } else errors.push(`${where}: unknown flag "${f}"`);
      }
      if (entry.isDefault && versions.some((v) => v.tool === head && v.isDefault)) {
        errors.push(`${where}: second default for ${head}`);
      }
      if (entry.autoload && versions.some((v) => v.tool === head && v.autoload)) {
        errors.push(`${where}: second autoload for ${head}`);
      }
      if (entry.onPath && versions.some((v) => v.tool === head && v.onPath)) {
        errors.push(`${where}: second onpath for ${head}`);
      }
      versions.push(entry);
    });

  for (const t of tools) {
    const vs = versions.filter((v) => v.tool === t.name);
    if (vs.some((v) => v.autoload) && vs.some((v) => v.onPath)) {
      errors.push(`${t.name}: autoload and onpath are exclusive (autoload already puts it on PATH)`);
    }
  }

  if (errors.length > 0) {
    throw new ManifestError(`Invalid manifest ${path}:\n  ${errors.join("\n  ")}`);
  }
  return { path, tools, versions, images };
}

// ---------------------------------------------------------------------------
// Lookup & version matching
// ---------------------------------------------------------------------------

/** Find a tool by manifest name or ~/Components dir name (case-insensitive). */
export function findTool(m: Manifest, name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return (
    m.tools.find((t) => t.name.toLowerCase() === lower) ??
    m.tools.find((t) => t.dir.toLowerCase() === lower)
  );
}

/** Numeric-aware version compare ("9.3" < "10.0"). */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Approved versions for a tool, sorted. */
export function versionsOf(m: Manifest, tool: ToolDef): VersionEntry[] {
  return m.versions
    .filter((v) => v.tool === tool.name)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Resolve a requested version against the manifest.
 * Exact match, else a unique prefix on a version-segment boundary
 * ("17" → "17", "3.9" → "3.9.12", "2" never matches "25"). Empty → default.
 */
export function resolveVersion(m: Manifest, tool: ToolDef, query?: string): VersionEntry {
  const all = versionsOf(m, tool);
  const listed = all.map((v) => v.version).join(", ") || "none";

  if (!query) {
    const def = all.find((v) => v.isDefault);
    if (!def) throw new ManifestError(`No default ${tool.name} version. Approved: ${listed}`);
    return def;
  }

  const exact = all.find((v) => v.version === query);
  if (exact) return exact;

  const matches = all.filter((v) => v.version.startsWith(query + ".") || v.version.startsWith(query + "-"));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ManifestError(
      `"${query}" is ambiguous for ${tool.name}: ${matches.map((v) => v.version).join(", ")}`,
    );
  }
  throw new ManifestError(`${tool.name} ${query} is not approved. Approved: ${listed}`);
}

// ---------------------------------------------------------------------------
// Filesystem health
// ---------------------------------------------------------------------------

export interface Resolved {
  home: string;
  binDir: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Locate home + bin dir for a version on disk, or explain why it can't. */
export function locate(tool: ToolDef, version: string): Resolved | { problem: string } {
  const base = join(COMPONENTS_ROOT, tool.dir, version);
  if (!isDir(base)) return { problem: `missing on disk (${base})` };

  const home = tool.root.map((r) => join(base, r)).find(isDir);
  if (!home) return { problem: `no tool home (${tool.root.join(" | ")}) under ${base}` };

  const binDir = tool.bin
    .map((b) => join(home, b))
    .find((d) => isDir(d) && (!tool.check || existsSync(join(d, tool.check))));
  if (!binDir) {
    return { problem: `no ${tool.check ?? "bin dir"} in ${tool.bin.join(" | ")} under ${home}` };
  }
  return { home, binDir };
}

/** Version folders on disk that pass the check but are not in the manifest. */
export function unlistedOnDisk(m: Manifest, tool: ToolDef): string[] {
  const dir = join(COMPONENTS_ROOT, tool.dir);
  if (!isDir(dir)) return [];
  const listed = new Set(versionsOf(m, tool).map((v) => v.version));
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !listed.has(d.name))
    .filter((d) => !("problem" in locate(tool, d.name)))
    .map((d) => d.name)
    .sort(compareVersions);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface ComponentEnv {
  /** Env vars to export (name → value) */
  vars: [string, string][];
  /** Bin dirs to prepend to PATH, in order */
  path: string[];
  /** What was selected, for display */
  selected: { tool: string; version: string }[];
}

/** Compute the env for a set of {tool: version} selections ("" = default). */
export function envFor(m: Manifest, selection: Record<string, string>): ComponentEnv {
  const env: ComponentEnv = { vars: [], path: [], selected: [] };
  for (const [name, query] of Object.entries(selection)) {
    const tool = findTool(m, name);
    if (!tool) {
      throw new ManifestError(
        `Unknown component "${name}". Available: ${m.tools.map((t) => t.name).join(", ")}`,
      );
    }
    const entry = resolveVersion(m, tool, query);
    const loc = locate(tool, entry.version);
    if ("problem" in loc) throw new ManifestError(`${tool.name} ${entry.version}: ${loc.problem}`);
    for (const v of tool.homeEnv) env.vars.push([v, loc.home]);
    env.path.push(loc.binDir);
    env.selected.push({ tool: tool.name, version: entry.version });
  }
  return env;
}

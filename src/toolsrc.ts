import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// .toolsrc — per-project tool versions (same keys as the zsh `toolup`)
// ---------------------------------------------------------------------------

const KEY_TO_TOOL: Record<string, string> = {
  JDK: "jdk",
  MAVEN: "maven",
  GRADLE: "gradle",
  ANT: "ant",
  NODE: "node",
  GO: "go",
  PYTHON: "python",
  PROTOBUF: "protobuf",
  REDIS: "redis",
  RUST: "rust",
  MYSQL_DEFAULT_VER: "mysql",
};

// Shell-only directives: they run code or start services, so agents don't get them.
const SHELL_ONLY = new Set(["PATH_PREPEND", "EXPORT", "MYSQL_START_VER", "MYSQL_STOP_VER"]);

export interface Toolsrc {
  path: string;
  /** component → version (empty values are skipped, like toolup) */
  tools: Record<string, string>;
  /** directives that only `toolup` applies */
  shellOnly: string[];
  unknown: string[];
}

export function readToolsrc(dir: string): Toolsrc | undefined {
  const path = join(dir, ".toolsrc");
  if (!existsSync(path)) return undefined;
  const result: Toolsrc = { path, tools: {}, shellOnly: [], unknown: [] };
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = (eq >= 0 ? line.slice(0, eq) : line).trim();
    const val = eq >= 0 ? line.slice(eq + 1).replace(/\s+#.*$/, "").trim() : "";
    const tool = KEY_TO_TOOL[key];
    if (tool) {
      if (val) result.tools[tool] = val;
    } else if (SHELL_ONLY.has(key)) {
      result.shellOnly.push(key);
    } else {
      result.unknown.push(key);
    }
  }
  return result;
}

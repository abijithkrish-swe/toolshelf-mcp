import { existsSync, readFileSync } from "node:fs";
import { BLOCKLIST_PATH } from "./paths.js";

// ---------------------------------------------------------------------------
// Blocklist — commands agents must never run. Format per line:
//   <regex> ## <reason>
// A missing or invalid blocklist refuses every run (fail closed).
// ---------------------------------------------------------------------------

export interface BlockRule {
  pattern: RegExp;
  reason: string;
  line: number;
}

export class BlocklistError extends Error {}

export function loadBlocklist(): BlockRule[] {
  if (!existsSync(BLOCKLIST_PATH)) {
    throw new BlocklistError(
      `Blocklist not found at ${BLOCKLIST_PATH}; refusing to run commands. ` +
        `Deploy dotfiles (install_copy.sh deploy) or set TOOLSHELF_BLOCKLIST.`,
    );
  }
  const rules: BlockRule[] = [];
  const errors: string[] = [];
  readFileSync(BLOCKLIST_PATH, "utf-8")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const sep = line.indexOf(" ## ");
      const source = (sep >= 0 ? line.slice(0, sep) : line).trim();
      const reason = sep >= 0 ? line.slice(sep + 4).trim() : "blocked by policy";
      try {
        rules.push({ pattern: new RegExp(source), reason, line: i + 1 });
      } catch (err) {
        errors.push(`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  if (errors.length) {
    throw new BlocklistError(`Invalid blocklist ${BLOCKLIST_PATH}:\n  ${errors.join("\n  ")}`);
  }
  return rules;
}

/** First rule the command matches, or undefined. */
export function matchBlocklist(rules: BlockRule[], command: string): BlockRule | undefined {
  return rules.find((r) => r.pattern.test(command));
}

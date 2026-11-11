import { readFileSync } from "node:fs";
import { AGENTS_MD_PATH } from "./paths.js";

// ---------------------------------------------------------------------------
// Server instructions: the user's agent rules, sent to every MCP client at
// connect (Claude Code, the Claude app, Codex / ChatGPT, VS Code …), so apps
// that never read AGENTS.md still get them.
//
// Single source: ~/.config/agents/AGENTS.md (dotfiles), read once at startup.
// Edit it there and deploy; clients get the new text on their next connect.
// Missing file (e.g. dotfiles not deployed yet) → a short built-in fallback.
// ---------------------------------------------------------------------------

export const FALLBACK = `toolshelf provides the user's approved developer tools. The agent rules file (${AGENTS_MD_PATH}) is missing, so tell the user. Until it is back: do not install, upgrade or remove tools (call request_component for a missing version); use run for builds and tests, with mode "docker" for untrusted code; do not read secrets.`;

export function loadInstructions(): string {
  try {
    const text = readFileSync(AGENTS_MD_PATH, "utf-8").trim();
    if (text) return text;
  } catch {
    // fall through
  }
  return FALLBACK;
}

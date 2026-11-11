import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// XDG locations used by the server (env overrides first, then XDG, then default)
// ---------------------------------------------------------------------------

const HOME = homedir();

const xdg = (name: string, fallback: string) => process.env[name] || join(HOME, fallback);

export const XDG_CONFIG_HOME = xdg("XDG_CONFIG_HOME", ".config");
export const XDG_CACHE_HOME = xdg("XDG_CACHE_HOME", ".cache");
export const XDG_STATE_HOME = xdg("XDG_STATE_HOME", ".local/state");

/** Commands agents must never run (shared with the Claude Code hook). */
export const BLOCKLIST_PATH =
  process.env.TOOLSHELF_BLOCKLIST || join(XDG_CONFIG_HOME, "agents", "blocklist.txt");

/** The agent rules (dotfiles DotFiles/config/agents/AGENTS.md), sent as server instructions. */
export const AGENTS_MD_PATH =
  process.env.TOOLSHELF_AGENTS_MD || join(XDG_CONFIG_HOME, "agents", "AGENTS.md");

/** Sandbox-only caches (m2, gradle, npm, cargo, go) — never the user's own. */
export const CACHE_ROOT = process.env.TOOLSHELF_CACHE || join(XDG_CACHE_HOME, "toolshelf");

/** Run logs, generated sandbox profiles, component requests. */
export const STATE_ROOT = process.env.TOOLSHELF_STATE || join(XDG_STATE_HOME, "toolshelf");

export const REQUESTS_PATH = join(STATE_ROOT, "requests.jsonl");

export { HOME };

import { existsSync } from "node:fs";
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

/**
 * Colima's home, for the colima_* tools. Apps start this server without the
 * user's shell variables, so a COLIMA_HOME set in zsh (e.g. ~/.config/colima)
 * is missing here. colima then looks in ~/.colima and reports "not running"
 * for a running VM. Use the XDG location when it holds the `default` profile
 * and ~/.colima doesn't. (A bare ~/.colima/_lima appears as soon as colima
 * runs once without COLIMA_HOME, so "~/.colima exists" proves nothing.)
 * Read when called, so tests can change the env.
 */
export function colimaHome(): string | undefined {
  if (process.env.COLIMA_HOME) return process.env.COLIMA_HOME;
  const home = process.env.HOME || homedir();
  const xdgColima = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "colima");
  return existsSync(join(xdgColima, "default")) && !existsSync(join(home, ".colima", "default"))
    ? xdgColima
    : undefined;
}

export { HOME };

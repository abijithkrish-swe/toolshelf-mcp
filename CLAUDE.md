# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server (`toolshelf`, package `toolshelf-mcp`) that exposes the user's approved developer components to AI agents. The approved list is a line-based manifest, `~/.config/components/components.conf` (source of truth lives in the zshrc dotfiles repo: `DotFiles/config/components/components.conf`). Design and runbooks: `~/Projects/Personal/zshrc/configured/Docs/AgentComponents.md`.

## Build & Run

```bash
npm install
npm run build    # tsc → dist/
npm test         # tsc + node --test test/*.test.mjs
./install.sh     # build + test a copy into ~/Components/toolshelf-mcp (source untouched); --register to add to Claude Code
npm run dev      # tsc --watch
```

Tests: `test/*.test.mjs` (Node's built-in runner, against `dist/`); see the README table. Each file sets up a fake `$HOME` via `test/helpers.mjs` **before** importing from `dist/` (paths are read at module load). Add a test with every behaviour change. Real-sandbox tests skip inside toolshelf's own sandbox (`TOOLSHELF_SANDBOX` set); run the full suite from a terminal. `install.sh` runs the suite and refuses to install on a failure. The manifest is also parsed by zsh (dotfiles `70-components-core.zsh`); after any parser change run the dotfiles parity check, `TOOLSHELF_DIST=$PWD/dist zsh -f ~/Projects/Personal/zshrc/configured/tests/components/parity.zsh`, and change both parsers together.

## Architecture

- **`components.ts`** — manifest parser (`loadManifest`, errors with line numbers), lookup (`findTool` by name or dir), version matching (`resolveVersion`: exact or unique segment-boundary prefix; empty → default), disk health (`locate`, `unlistedOnDisk`), and env computation (`envFor`).
- **`index.ts`** — MCP tools: `list_components`, `get_component_versions`, `get_defaults`, `get_component_env`, `resolve_toolsrc`, `run`, `request_component`, plus colima tools that only return commands.
- **`docker.ts`** — `run` docker mode: one pinned image per run (manifest `docker=`), per-run internal network + `@image proxy-forwarder` for `network: "proxy"`, container limits, cleanup.
- **`sandbox.ts`** — `run`: project-dir validation, sandbox-only caches (generated Maven settings.xml / Gradle gradle.properties with proxy), minimal env, generated `sandbox-exec` profile (writes: project + caches; reads: no secrets/~/Library; network: localhost only), process-group timeout, log files.
- **`instructions.ts`** — reads the user's `~/.config/agents/AGENTS.md` (single source, in the dotfiles) at startup and sends it as MCP server instructions, so every client (Claude app, Codex/ChatGPT, VS Code) gets the rules even without reading that file. Missing file → a short built-in fallback. Never copy rule text into this repo; size and content checks live in the dotfiles (`tests/agents/agents-md-test.pl`).
- **`blocklist.ts`** — loads `<regex> ## <reason>` rules (fail closed). **`toolsrc.ts`** — `.toolsrc` parsing. **`paths.ts`** — XDG locations.

`config/` holds registration snippets for Claude Code, VS Code and Codex (manual use only). **`scripts/register.mjs`** — run by `install.sh --register` after the Claude Code step: writes the toolshelf entry into the Claude app's JSON and Codex's TOML (text edit, backup first, idempotent), reports stale servers, removes them with `--remove-stale`. Tests: `test/register.test.mjs`.

## Key Design Decisions

- The manifest is the allowlist: a folder on disk that isn't listed is invisible to agents (reported as "on disk but not approved").
- The manifest is re-read on every tool call; adding a component never needs a rebuild.
- Adding a component type = an `@tool` line in the manifest, no code change.
- No install/upgrade tools. Agents get env exports, not `use_*` shell commands (those depend on zsh helpers missing from agent shells).
- Docker images in the manifest must be pinned by digest.
- The source repo is never run in place: `install.sh` builds a staged copy with the manifest's default Node and swaps it into `~/Components/toolshelf-mcp` (same idea as the dotfiles' copy-based installer).

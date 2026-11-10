# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server (`toolshelf`, package `toolshelf-mcp`) that exposes the user's approved developer components to AI agents. The approved list is a line-based manifest, `~/.config/components/components.conf` (source of truth lives in the zshrc dotfiles repo: `DotFiles/config/components/components.conf`). Design and runbooks: `~/Projects/Personal/zshrc/configured/Docs/AgentComponents.md`.

## Build & Run

```bash
npm install
npm run build    # tsc → dist/
./install.sh     # build a copy into ~/Components/toolshelf-mcp (source untouched); --register to add to Claude Code
npm run dev      # tsc --watch
```

No test suite yet. Manual test: pipe JSON-RPC (`initialize`, `notifications/initialized`, `tools/call`) into `node dist/index.js`, with `COMPONENTS_MANIFEST` pointing at a test manifest.

## Architecture

- **`components.ts`** — manifest parser (`loadManifest`, errors with line numbers), lookup (`findTool` by name or dir), version matching (`resolveVersion`: exact or unique segment-boundary prefix; empty → default), disk health (`locate`, `unlistedOnDisk`), and env computation (`envFor`).
- **`index.ts`** — MCP tools: `list_components`, `get_component_versions`, `get_defaults`, `get_component_env`, plus colima tools that only return commands.

`config/` holds registration snippets for Claude Code, VS Code and Codex.

## Key Design Decisions

- The manifest is the allowlist: a folder on disk that isn't listed is invisible to agents (reported as "on disk but not approved").
- The manifest is re-read on every tool call; adding a component never needs a rebuild.
- Adding a component type = an `@tool` line in the manifest, no code change.
- No install/upgrade tools. Agents get env exports, not `use_*` shell commands (those depend on zsh helpers missing from agent shells).
- Docker images in the manifest must be pinned by digest.
- The source repo is never run in place: `install.sh` builds a staged copy with the manifest's default Node and swaps it into `~/Components/toolshelf-mcp` (same idea as the dotfiles' copy-based installer).

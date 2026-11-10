# toolshelf-mcp

An MCP server that exposes your approved developer components
(`~/Components/<Tool>/<Version>/`) to AI agents: Claude Code, Codex, Copilot,
or any MCP client. Server name: `toolshelf`.

The approved list is the manifest `~/.config/components/components.conf`
(source: `zshrc/configured/DotFiles/config/components/components.conf`).
Agents only see versions listed there. The server re-reads it on every call,
so editing it needs no rebuild or restart.

Full design & runbooks: `~/Projects/Personal/zshrc/configured/Docs/AgentComponents.md`.

## Tools

| Tool | Description |
|------|-------------|
| `list_components` | Approved components/versions + on-disk health (broken, on-disk-but-unapproved) |
| `get_component_versions` | Approved versions for one component |
| `get_defaults` | `default` / `autoload` versions from the manifest |
| `get_component_env` | Shell exports (`JAVA_HOME`, `PATH`, …) for `{tool: version}`; agents prefix commands with them |
| `colima_status` | Colima / Docker / k8s status |
| `colima_start` / `colima_stop` / `colima_restart` / `colima_delete` / `docker_context_use_colima` | Return the command for the user to run (never executed) |

There is deliberately no install/upgrade tool.

Version matching: exact, or a unique prefix on a segment boundary
(`17` → `17`, `3.9` → `3.9.12`; `2` never matches `25`). Empty version = manifest default.

## Install

Like the dotfiles, the source repo is never run directly. `install.sh` copies it
to a staging dir, builds there with the manifest's **default Node**, runs a
smoke test, then swaps it into the install dir. A failed build leaves the live
install untouched.

```bash
./install.sh                                  # install / update to ~/Components/toolshelf-mcp
./install.sh --register                       # also (re)register in Claude Code, user scope
./install.sh --prefix ~/opt/toolshelf-mcp     # install somewhere else
./install.sh --components /Volumes/Dev/Components --manifest ~/dev/components.conf --register
./install.sh --help
```

| Option | Default |
|--------|---------|
| `--prefix DIR` | `<components>/toolshelf-mcp` (env `TOOLSHELF_HOME`) |
| `--components DIR` | env `COMPONENTS`, else `~/Components` |
| `--manifest FILE` | env `COMPONENTS_MANIFEST`, else `~/.config/components/components.conf` |
| `--register` | off |

Safety:
- The installer refuses an install dir inside the source tree, `/`, `$HOME`, or
  the components root itself.
- It only replaces an existing non-empty dir if that dir is a previous install,
  meaning it has an `INSTALLED` file.

`<prefix>/INSTALLED` records the source revision, node, paths and date.
`--register` passes `COMPONENTS` and `COMPONENTS_MANIFEST` to the server, so
non-default layouts work at runtime. Re-run it after changing the default `node`
in the manifest, because the registration points at that node's absolute path.

## Development

```bash
npm install
npm run build    # tsc → dist/ (gitignored)
npm run dev      # tsc --watch
```

Manual test: pipe JSON-RPC (`initialize`, `notifications/initialized`,
`tools/call`) into `node dist/index.js`, with `COMPONENTS_MANIFEST` pointing at
a test manifest.

## Environment

| Var | Default |
|-----|---------|
| `COMPONENTS_MANIFEST` | `~/.config/components/components.conf` |
| `COMPONENTS` | `~/Components` |
| `TOOLSHELF_HOME` (install.sh only, same as `--prefix`) | `<components>/toolshelf-mcp` |

## Other agents

Registration snippets for Claude Code, VS Code (Copilot) and Codex are in `config/`.
Always use the absolute node path, because each agent's PATH is different.

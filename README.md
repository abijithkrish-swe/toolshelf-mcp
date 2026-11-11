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
| `resolve_toolsrc` | A project's `.toolsrc` → exports + the `tools` map for `run` |
| `run` | Run a command in the macOS sandbox with approved versions: project-only writes (cwd must be a project: .git, package.json, pom.xml, … or an empty .toolshelf), sandbox-only caches, localhost/proxy-only network, secrets unreadable, minimal env, blocklist, timeout, log file. Temp files go in `$TMPDIR` (private per run; `/tmp` isn't writable), and the reply carries a note whenever the sandbox refused something, even on exit 0 |
| `run` (`mode: "docker"`) | Untrusted code: a throwaway container from the one requested tool's pinned image (manifest `docker=`), project at `/work`, nothing else from the host, no caches between runs. `network: "none"` (default) or `"proxy"`: an internal per-run network whose only exit is a pinned forwarder to the zero-trust proxy. Needs Colima running |
| `request_component` | Record a request for an unapproved version (`components_requests` in zsh). Never installs |
| `colima_status` | Colima / Docker / k8s status |
| `colima_start` / `colima_stop` / `colima_restart` / `colima_delete` / `docker_context_use_colima` | Return the command for the user to run (never executed) |

There is deliberately no install/upgrade tool.

Version matching: exact, or a unique prefix on a segment boundary
(`17` → `17`, `3.9` → `3.9.12`; `2` never matches `25`). Empty version = manifest default.

## Install

Like the dotfiles, the source repo is never run directly. `install.sh` copies it
to a staging dir, builds there with the manifest's **default Node**, runs the
test suite and a smoke test, then swaps it into the install dir. A failed build
or test leaves the live install untouched (`--skip-tests` to bypass).

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
| `--skip-tests` | off: tests run before every install |
| `--print-config` | print how to register in Codex / ChatGPT, the Claude app and Cursor, then exit |

Safety:
- The installer refuses an install dir inside the source tree, `/`, `$HOME`, or
  the components root itself.
- It only replaces an existing non-empty dir if that dir is a previous install,
  meaning it has an `INSTALLED` file.

`<prefix>/INSTALLED` records the source revision, node, paths and date.
`--register` passes `COMPONENTS` and `COMPONENTS_MANIFEST` to the server, so
non-default layouts work at runtime. It registers **Claude Code**: the default
config and `~/.config/claude-personal` (`myclaude`), via `claude mcp add`.

**Other apps you register by hand**, so you see every change to their
configs. `./install.sh --print-config` prints, with this machine's paths:
- **Codex** (the CLI, and Codex in the ChatGPT app; both use
  `~/.codex/config.toml`): one `codex mcp add …` command. It uses the
  ChatGPT app's bundled `codex` when none is on PATH.
- **Claude app** (Chat / Cowork): the JSON for `mcpServers` in
  `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Cursor:** the same JSON, for `~/.cursor/mcp.json`.

Install prints this on the first install and whenever the node path changes,
because every registration points at that absolute path. Restart each app
after changing it. Re-run it after changing the default `node`
in the manifest, because the registration points at that node's absolute path.

## Development

```bash
npm install
npm run build    # tsc → dist/ (gitignored)
npm run dev      # tsc --watch
npm test         # tsc + node --test test/*.test.mjs (~3 s, no extra dependencies)
```

Tests use Node's built-in runner and run against `dist/`. Each file builds a
throwaway `$HOME` (`test/helpers.mjs`) with its own manifest, fake components,
blocklist and state, so your real ones are never read or written.

| File | Covers |
|------|--------|
| `manifest.test.mjs` | parsing, every rejection rule, digest pinning |
| `versions.test.mjs` | default/exact/prefix matching (`2` ≠ `25`), ambiguity, disk health, `envFor` |
| `blocklist.test.mjs` | fail-closed loading, matching, `blocked.jsonl` records |
| `project.test.mjs` | what counts as a project (markers, private dirs, symlinks), `.toolsrc`, proxy |
| `sandbox.test.mjs` | real `sandbox-exec` runs: writes, secrets, env, network, `$TMPDIR`, timeout, tail, logs |
| `server.test.mjs` | the MCP server over stdio: tools, blocked `run`, `request_component`, the sandbox note |

The real-sandbox tests skip themselves when they run inside toolshelf's own
sandbox (an agent's `run`), since `sandbox-exec` can't nest; run `npm test`
from a terminal for the full suite.

## Environment

| Var | Default |
|-----|---------|
| `COMPONENTS_MANIFEST` | `~/.config/components/components.conf` |
| `COMPONENTS` | `~/Components` |
| `TOOLSHELF_AGENTS_MD` | `$XDG_CONFIG_HOME/agents/AGENTS.md`, the agent rules sent as server instructions (missing → short fallback) |
| `TOOLSHELF_BLOCKLIST` | `$XDG_CONFIG_HOME/agents/blocklist.txt` (missing → every run refused) |
| `TOOLSHELF_CACHE` | `$XDG_CACHE_HOME/toolshelf` (sandbox-only caches) |
| `TOOLSHELF_STATE` | `$XDG_STATE_HOME/toolshelf` (run logs, profiles, requests, `blocked.jsonl`: blocklist hits, same format as the dotfiles guard hook) |
| `TOOLSHELF_PROXY` | `$https_proxy`, else `http://127.0.0.1:3128` (must be localhost) |
| `TOOLSHELF_HOME` (install.sh only, same as `--prefix`) | `<components>/toolshelf-mcp` |

## Other agents

Registration snippets for Claude Code, VS Code (Copilot) and Codex are in `config/`.
Always use the absolute node path, because each agent's PATH is different.

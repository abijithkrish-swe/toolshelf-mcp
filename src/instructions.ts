// ---------------------------------------------------------------------------
// Server instructions: the agent rules, sent to every MCP client at connect
// (Claude Code, the Claude app, Codex / ChatGPT, VS Code …). Clients that never
// see the user's AGENTS.md still get the essentials this way.
//
// Compact on purpose: it costs tokens in every session, and Claude Code also
// loads the full rules (dotfiles DotFiles/config/agents/AGENTS.md). Keep the
// two in sync: a rule added there that matters for tool use belongs here too.
// ---------------------------------------------------------------------------

export const INSTRUCTIONS = `toolshelf provides the user's approved developer tools. Rules:
1. Use only versions toolshelf lists (list_components, get_component_env, resolve_toolsrc). Not Homebrew or other tools on PATH.
2. Never install, upgrade or remove tools, runtimes or global packages: no brew, sudo, rustup, nvm, sdkman, pyenv, npm -g, pip outside a project venv, cargo install, npx -y, curl | sh. If a version is missing, call request_component and tell the user.
3. Build and test with run (macOS sandbox: project-only writes, proxy-only network, no secrets). Untrusted code (unknown repos, downloaded scripts, unreviewed generated code): run with mode "docker", one tool per run; network is off unless network "proxy".
4. run is for builds, tests and scripts, not for editing files. Temp files go in $TMPDIR. Use quiet flags (mvn -q, gradle -q, npm --silent) and tail_kb instead of piping to tail.
5. Don't change toolchain versions (Gradle/Maven wrappers, Docker images, Gradle JDK auto-download, GOTOOLCHAIN). Ask before adding or upgrading project dependencies.
6. Never read or print secrets: ~/.ssh, ~/.config/secrets, tokens, .env files.`;

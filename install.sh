#!/bin/sh
# -----------------------------------------------------------------------------
# install.sh — build and install toolshelf-mcp from this source tree
#
# The source tree is never modified: files are copied to a staging dir next to
# the target, built there with the manifest's default Node, tested (test/),
# smoke-tested, and only then swapped into place. A failed build or test leaves
# the live install alone.
#
# Usage: ./install.sh [options]
#   --prefix DIR       install dir             (default: <components>/toolshelf-mcp)
#   --components DIR   components root         (default: $COMPONENTS or ~/Components)
#   --manifest FILE    approved-list manifest  (default: $COMPONENTS_MANIFEST or
#                                               ~/.config/components/components.conf)
#   --register         also (re)register in Claude Code (user scope) — default
#                      config and ~/.config/claude-personal if it exists
#   --print-config     only print how to register in the other apps (Codex /
#                      ChatGPT, Claude app, Cursor), with this machine's paths
#   --skip-tests       don't run the test suite before installing (it runs in a
#                      fake $HOME and takes a few seconds; a failure aborts)
#   -h, --help         show this help
#
# Other apps are registered by hand from --print-config: you see each change.
# It is printed after the first install and whenever the node path changes
# (every registration points at that absolute path).
#
# Env fallbacks: TOOLSHELF_HOME (= --prefix), COMPONENTS, COMPONENTS_MANIFEST.
# The components root and manifest are passed to the server at registration,
# so non-default layouts keep working at runtime.
# -----------------------------------------------------------------------------
set -eu

die() { echo "install.sh: $*" >&2; exit 1; }
usage() { sed -n '/^# Usage:/,/^# Env fallbacks:/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

# Absolute path; expands a leading ~ (not expanded in --opt=~/x by the shell).
abspath() {
  case "$1" in
    "~") p=$HOME ;;
    "~/"*) p=$HOME/${1#"~/"} ;;
    *) p=$1 ;;
  esac
  case "$p" in
    /*) ;;
    *) p=$PWD/$p ;;
  esac
  echo "${p%/}"
}

SRC=$(cd "$(dirname "$0")" && pwd)
TARGET=${TOOLSHELF_HOME:-}
COMPONENTS=${COMPONENTS:-$HOME/Components}
MANIFEST=${COMPONENTS_MANIFEST:-$HOME/.config/components/components.conf}
REGISTER=false
RUN_TESTS=true
PRINT_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)       [ $# -ge 2 ] || die "--prefix needs a directory"; TARGET=$2; shift ;;
    --prefix=*)     TARGET=${1#*=} ;;
    --components)   [ $# -ge 2 ] || die "--components needs a directory"; COMPONENTS=$2; shift ;;
    --components=*) COMPONENTS=${1#*=} ;;
    --manifest)     [ $# -ge 2 ] || die "--manifest needs a file"; MANIFEST=$2; shift ;;
    --manifest=*)   MANIFEST=${1#*=} ;;
    --register)     REGISTER=true ;;
    --skip-tests)   RUN_TESTS=false ;;
    --print-config) PRINT_ONLY=true ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; exit 2 ;;
  esac
  shift
done

COMPONENTS=$(abspath "$COMPONENTS")
MANIFEST=$(abspath "$MANIFEST")
TARGET=$(abspath "${TARGET:-$COMPONENTS/toolshelf-mcp}")

# --- Safety: never clobber something that isn't a previous install ----------
case "$TARGET" in
  /|"$HOME"|"$COMPONENTS") die "refusing to install into $TARGET" ;;
  "$SRC"|"$SRC"/*) die "install dir must be outside the source tree ($SRC)" ;;
esac
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ] && [ ! -f "$TARGET/INSTALLED" ]; then
  die "$TARGET exists and is not a toolshelf-mcp install (no INSTALLED file); choose another --prefix"
fi

# --- Node: the manifest's default node version (approved list, not PATH) ----
[ -d "$COMPONENTS" ] || die "components root not found: $COMPONENTS"
[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST (deploy dotfiles first)"
NODE_DIR=$(awk '$1 == "@tool" && $2 == "node" { for (i = 3; i <= NF; i++) if ($i ~ /^dir=/) print substr($i, 5) }' "$MANIFEST")
[ -n "$NODE_DIR" ] || die "no '@tool node dir=...' in $MANIFEST"
NODE_VER=$(awk '$1 == "node" { for (i = 3; i <= NF; i++) if ($i == "default") print $2 }' "$MANIFEST")
[ -n "$NODE_VER" ] || die "no default node version in $MANIFEST"
NODE_BIN=$COMPONENTS/$NODE_DIR/$NODE_VER/bin
[ -x "$NODE_BIN/node" ] || die "node $NODE_VER not installed at $NODE_BIN"
PATH=$NODE_BIN:$PATH
export PATH

# --- Other MCP clients: printed instructions, applied by hand -----------------
# Single-quote a value for a pasteable shell command.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
print_config() {
  server=$TARGET/dist/index.js
  codex=$(command -v codex 2>/dev/null || true)
  [ -n "$codex" ] || [ ! -x /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex ] \
    || codex=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
  # JSON built by node, so paths are escaped correctly
  entry=$(node -e 'const [n, s, c, m] = process.argv.slice(1);
    console.log(JSON.stringify({ mcpServers: { toolshelf: { command: n, args: [s],
      env: { COMPONENTS: c, COMPONENTS_MANIFEST: m } } } }, null, 2));' \
    "$NODE_BIN/node" "$server" "$COMPONENTS" "$MANIFEST")
  cat <<EOF
==> Register toolshelf in your other apps (by hand; restart each app afterwards)

Codex — the CLI and Codex in the ChatGPT app share ~/.codex/config.toml:
  $(sq "${codex:-codex}") mcp remove toolshelf >/dev/null 2>&1; $(sq "${codex:-codex}") mcp add toolshelf --env $(sq "COMPONENTS=$COMPONENTS") --env $(sq "COMPONENTS_MANIFEST=$MANIFEST") -- $(sq "$NODE_BIN/node") $(sq "$server")
  (check with: $(sq "${codex:-codex}") mcp list)

Claude app (Chat / Cowork) — merge into "mcpServers" in
  ~/Library/Application Support/Claude/claude_desktop_config.json
$entry

Cursor — merge into "mcpServers" in ~/.cursor/mcp.json (create the file with this if it's missing)
$entry

Old entries: remove any server that points at the retired MyComponentsMCP
(Codex: '<codex>' mcp list, then mcp remove <name>; the apps: delete it from the JSON).
EOF
}
if $PRINT_ONLY; then
  print_config
  exit 0
fi
# Registrations point at the node path; when it changes, they all need redoing.
OLD_NODE=$(sed -n 's/^node=//p' "$TARGET/INSTALLED" 2>/dev/null || true)

echo "==> Installing to $TARGET"
echo "    components: $COMPONENTS"
echo "    manifest:   $MANIFEST"
echo "    node:       $NODE_VER"

# --- Stage ------------------------------------------------------------------
mkdir -p "$(dirname "$TARGET")"
STAGE=$(mktemp -d "$(dirname "$TARGET")/.toolshelf-mcp.stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

echo "==> Copying source to staging"
for f in package.json package-lock.json tsconfig.json README.md install.sh src config test; do
  cp -R "$SRC/$f" "$STAGE/"
done

echo "==> Building"
(
  cd "$STAGE"
  npm ci --prefer-offline --no-audit --no-fund --loglevel=error
  npm run --silent build
)

if $RUN_TESTS; then
  echo "==> Tests (fake \$HOME; your manifest, logs and caches are not touched)"
  (cd "$STAGE" && node --test --test-reporter=dot test/*.test.mjs) \
    || die "tests failed; nothing was installed (details: cd $SRC && npm test)"
fi
(
  cd "$STAGE"
  rm -rf test
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
)

echo "==> Smoke test"
INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh","version":"0"}}}'
{ echo "$INIT"; sleep 1; } | node "$STAGE/dist/index.js" | grep -q '"name":"toolshelf"' \
  || die "smoke test failed: server did not answer initialize"

# --- Record what was installed ---------------------------------------------
REV=$(git -C "$SRC" describe --always --dirty 2>/dev/null || echo "not-a-git-repo")
{
  echo "source=$SRC"
  echo "revision=$REV"
  echo "node=$NODE_BIN/node"
  echo "components=$COMPONENTS"
  echo "manifest=$MANIFEST"
  echo "installed=$(date '+%Y-%m-%d %H:%M:%S')"
} > "$STAGE/INSTALLED"

# --- Swap into place --------------------------------------------------------
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.old"
  mv "$TARGET" "$TARGET.old"
fi
mv "$STAGE" "$TARGET"
trap - EXIT
rm -rf "$TARGET.old"
echo "==> Installed $REV to $TARGET"

# --- Register ---------------------------------------------------------------
if $REGISTER; then
  command -v claude >/dev/null 2>&1 || die "claude CLI not found; register manually (see README)"
  # Every Claude Code config on this machine: the default (~/.claude, MCP list in
  # ~/.claude.json) and the personal one used by `myclaude`
  # (CLAUDE_CONFIG_DIR=~/.config/claude-personal).
  register() {
    claude mcp remove toolshelf -s user >/dev/null 2>&1 || true
    claude mcp add toolshelf -s user \
      -e "COMPONENTS=$COMPONENTS" -e "COMPONENTS_MANIFEST=$MANIFEST" \
      -- "$NODE_BIN/node" "$TARGET/dist/index.js"
  }
  echo "==> Registering in Claude Code (default config)"
  (unset CLAUDE_CONFIG_DIR; register)
  PERSONAL=${XDG_CONFIG_HOME:-$HOME/.config}/claude-personal
  if [ -d "$PERSONAL" ]; then
    echo "==> Registering in Claude Code ($PERSONAL)"
    (CLAUDE_CONFIG_DIR=$PERSONAL; export CLAUDE_CONFIG_DIR; register)
  fi
else
  echo "Register in Claude Code (once, or after changing the default node or paths): ./install.sh --register"
fi

# Other apps: by hand. Show how on the first install and when the node path changed.
if [ "$OLD_NODE" != "$NODE_BIN/node" ]; then
  echo ""
  [ -n "$OLD_NODE" ] && echo "!!  The node path changed ($OLD_NODE → $NODE_BIN/node): re-register every app."
  print_config
else
  echo "Other apps (Codex / ChatGPT, Claude app, Cursor): ./install.sh --print-config"
fi

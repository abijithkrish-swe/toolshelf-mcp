#!/bin/sh
# -----------------------------------------------------------------------------
# install.sh — build and install toolshelf-mcp from this source tree
#
# The source tree is never modified: files are copied to a staging dir next to
# the target, built there with the manifest's default Node, smoke-tested, and
# only then swapped into place. A failed build leaves the live install alone.
#
# Usage: ./install.sh [options]
#   --prefix DIR       install dir             (default: <components>/toolshelf-mcp)
#   --components DIR   components root         (default: $COMPONENTS or ~/Components)
#   --manifest FILE    approved-list manifest  (default: $COMPONENTS_MANIFEST or
#                                               ~/.config/components/components.conf)
#   --register         also (re)register in Claude Code (user scope)
#   -h, --help         show this help
#
# Env fallbacks: TOOLSHELF_HOME (= --prefix), COMPONENTS, COMPONENTS_MANIFEST.
# The components root and manifest are passed to the server at registration,
# so non-default layouts keep working at runtime.
# -----------------------------------------------------------------------------
set -eu

die() { echo "install.sh: $*" >&2; exit 1; }
usage() { sed -n '9,19p' "$0" | sed 's/^# \{0,1\}//'; }

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

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)       [ $# -ge 2 ] || die "--prefix needs a directory"; TARGET=$2; shift ;;
    --prefix=*)     TARGET=${1#*=} ;;
    --components)   [ $# -ge 2 ] || die "--components needs a directory"; COMPONENTS=$2; shift ;;
    --components=*) COMPONENTS=${1#*=} ;;
    --manifest)     [ $# -ge 2 ] || die "--manifest needs a file"; MANIFEST=$2; shift ;;
    --manifest=*)   MANIFEST=${1#*=} ;;
    --register)     REGISTER=true ;;
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

echo "==> Installing to $TARGET"
echo "    components: $COMPONENTS"
echo "    manifest:   $MANIFEST"
echo "    node:       $NODE_VER"

# --- Stage ------------------------------------------------------------------
mkdir -p "$(dirname "$TARGET")"
STAGE=$(mktemp -d "$(dirname "$TARGET")/.toolshelf-mcp.stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

echo "==> Copying source to staging"
for f in package.json package-lock.json tsconfig.json README.md src config; do
  cp -R "$SRC/$f" "$STAGE/"
done

echo "==> Building"
(
  cd "$STAGE"
  npm ci --prefer-offline --no-audit --no-fund --loglevel=error
  npm run --silent build
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
  claude mcp remove toolshelf -s user >/dev/null 2>&1 || true
  claude mcp add toolshelf -s user \
    -e "COMPONENTS=$COMPONENTS" -e "COMPONENTS_MANIFEST=$MANIFEST" \
    -- "$NODE_BIN/node" "$TARGET/dist/index.js"
else
  echo "Register (once, or after changing the default node or paths):"
  echo "  claude mcp add toolshelf -s user -e 'COMPONENTS=$COMPONENTS' -e 'COMPONENTS_MANIFEST=$MANIFEST' -- '$NODE_BIN/node' '$TARGET/dist/index.js'"
fi

#!/bin/sh
# Puts the runner in bin/collie and a `collie` on PATH. Prefers the prebuilt release
# so consumers do not need bun — except in a git checkout, which is a machine
# developing the plugin and whose own source is newer than any release by definition.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' herdr-plugin.toml)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
esac

ASSET="collie-${OS}-${ARCH}"
# The tag is the version, with no `v` in front of it: the CI jobs build every registry
# path and release link from `$CI_COMMIT_TAG` verbatim, so a prefix here alone would
# point the installer at a release nothing publishes.
BASE="${COLLIE_RELEASE_BASE:-https://gitlab.cego.dk/mk/collie/-/releases/${VERSION}/downloads}"
BIN_DIR="${COLLIE_BIN_DIR:-$HOME/.local/bin}"
SHIM_MARKER="# installed by collie install.sh"

# Kept quiet unless it fails: `bun install` has a great deal to say about packages it
# did not have to touch, and `collie upgrade` reports what its caller asked about.
quietly() {
  if ! out=$("$@" 2>&1); then
    printf '%s\n' "$out" >&2
    return 1
  fi
}

build_from_source() {
  quietly bun install --frozen-lockfile
  # Build beside the binary and rename over it: replacing a running runner's own
  # file in place kills the process executing it. `collie upgrade` runs from that
  # very binary, so this is the load-bearing half of being able to upgrade at all.
  quietly bun build --compile --outfile bin/collie.new src/main.ts
  mv -f bin/collie.new bin/collie
}

# A private or internal project answers an unauthenticated download with a sign-in
# page and HTTP 200, which `curl -f` treats as success. Checking what actually
# arrived is the difference between falling back to a source build and installing
# 14KB of HTML as the runner.
looks_executable() {
  case "$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')" in
    7f454c46) return 0 ;;                     # ELF
    cffaedfe|cefaedfe|cafebabe|bebafeca) return 0 ;;  # Mach-O, and universal
    *) return 1 ;;
  esac
}

fetch_release() {
  # `COLLIE_TOKEN` for a project that is not public: without it the registry answers
  # every download with the login page above.
  if [ -n "${COLLIE_TOKEN:-}" ]; then
    set -- --header "PRIVATE-TOKEN: ${COLLIE_TOKEN}"
  else
    set --
  fi
  curl -fsSL "$@" "${BASE}/${ASSET}" -o bin/collie.new 2>/dev/null ||
    { rm -f bin/collie.new; return 1; }
  if ! looks_executable bin/collie.new; then
    rm -f bin/collie.new
    echo "what ${BASE}/${ASSET} returned is not a program${COLLIE_TOKEN:+}" >&2
    [ -n "${COLLIE_TOKEN:-}" ] || echo "  (set COLLIE_TOKEN if this project needs a login)" >&2
    return 1
  fi
  mv bin/collie.new bin/collie
  chmod +x bin/collie
}

# A `collie` on PATH that knows which checkout it belongs to. Without the plugin root
# pinned, the baseline workflows would be whichever directory you happened to be
# standing in, so `run list` would work anywhere and `run start` would not.
install_shim() {
  if [ -e "$BIN_DIR/collie" ] && ! grep -q "$SHIM_MARKER" "$BIN_DIR/collie" 2>/dev/null; then
    echo "not replacing $BIN_DIR/collie: something else is already there" >&2
    return 0
  fi
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/collie" <<EOF
#!/bin/sh
$SHIM_MARKER
exec env HERDR_PLUGIN_ROOT="\${HERDR_PLUGIN_ROOT:-$ROOT}" "$ROOT/bin/collie" "\$@"
EOF
  chmod +x "$BIN_DIR/collie"
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "installed $BIN_DIR/collie" ;;
    *) echo "installed $BIN_DIR/collie — add $BIN_DIR to PATH to use it" ;;
  esac
}

mkdir -p bin
if [ -d .git ] && command -v bun >/dev/null 2>&1; then
  echo "building from source: $ROOT is a checkout, and its source is what a release is cut from"
  build_from_source
elif fetch_release; then
  echo "installed ${ASSET} from ${BASE}"
elif command -v bun >/dev/null 2>&1; then
  echo "no release asset at ${BASE}/${ASSET}; building from source with bun"
  build_from_source
else
  echo "cannot install: no ${ASSET} at ${BASE} and no bun to build from source" >&2
  exit 1
fi

install_shim

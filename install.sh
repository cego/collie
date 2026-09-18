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
# The tag is the version, with no `v` in front of it: the release workflow names the
# release after the tag verbatim, so a prefix here alone would point the installer at a
# release nothing publishes.
BASE="${COLLIE_RELEASE_BASE:-https://github.com/cego/collie/releases/download/${VERSION}}"
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

# Whether there is anything to build: `bun build --compile` takes seconds and its
# output is not byte-identical run to run, so rebuilding an unchanged checkout both
# costs that and destroys the one signal `prepare.sh` has for saying the runner did
# not change. `find -newer` is the same question `make` asks.
needs_build() {
  [ -f bin/collie ] || return 0
  [ -n "$(find src package.json bun.lock herdr-plugin.toml -newer bin/collie 2>/dev/null | head -1)" ]
}

build_from_source() {
  quietly bun install --frozen-lockfile
  # The same script CI's release artifacts come from, not a second `bun build` that
  # could drift from it: it owns the JSX plugin, the libc pin, the build-beside-and-
  # rename dance, and the check that the binary carries its native renderer.
  quietly bun run tools/build.ts
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

# The host the release is fetched from, so a token can be borrowed from whichever CLI is
# already logged in to it.
# The port stays in: `glab` and `gh` key a login by host and port together, so dropping
# it would look up a different instance's token and send it to this one.
release_host() {
  printf '%s\n' "$BASE" | sed -n 's|^[A-Za-z][A-Za-z0-9+.-]*://\([^/]*@\)\{0,1\}\([^/]*\).*|\2|p'
}

# Which forge, from the URL shape rather than the hostname: GitLab download paths carry
# `/-/releases/` and GitHub's carry `/releases/download/`, and a self-hosted instance of
# either keeps its own shape, where its hostname says nothing.
release_forge() {
  case "$BASE" in
    */-/releases/*) echo gitlab ;;
    */releases/download/*) echo github ;;
    *) case "$(release_host)" in github.com | *.github.com) echo github ;; *) echo gitlab ;; esac ;;
  esac
}

# `COLLIE_TOKEN` wins. Without it, borrow the login the forge's own CLI already holds, so
# a machine set up with `glab` or `gh` needs no second credential to install from a project
# that is not public. Both print an empty token and still exit 0 for a host they do not
# know, so emptiness is what says there is nothing to send, not the exit status.
release_token() {
  if [ -n "${COLLIE_TOKEN:-}" ]; then
    printf '%s\n' "$COLLIE_TOKEN"
    return 0
  fi
  host=$(release_host)
  [ -n "$host" ] || return 1
  case "$(release_forge)" in
    github)
      command -v gh >/dev/null 2>&1 && gh auth token --hostname "$host" 2>/dev/null
      ;;
    *)
      command -v glab >/dev/null 2>&1 && glab config get token --host "$host" 2>/dev/null
      ;;
  esac
}

fetch_release() {
  # A project that is not public answers an unauthenticated download with the login page
  # above, so send a token wherever one can be had.
  token=$(release_token) || token=
  config=
  # `Authorization`, not GitLab's `PRIVATE-TOKEN`, for both forges: curl follows redirects
  # here, and it drops `Authorization` when one leaves the host while forwarding a custom
  # header to wherever it points. GitLab takes a personal access token either way, so the
  # header that a redirect cannot carry off the host is the one to send.
  if [ -n "$token" ]; then
    config="header = \"Authorization: Bearer ${token}\""
  fi
  # Through curl's config file on stdin rather than `--header`, so the token stays out of
  # this process's arguments where `ps` would show it to every user on the machine. It may
  # be the `glab` or `gh` login rather than something handed over for this one download.
  printf '%s\n' "$config" |
    curl -fsSL --config - "${BASE}/${ASSET}" -o bin/collie.new 2>/dev/null ||
    { rm -f bin/collie.new; return 1; }
  if ! looks_executable bin/collie.new; then
    rm -f bin/collie.new
    echo "what ${BASE}/${ASSET} returned is not a program" >&2
    if [ -z "$token" ]; then
      case "$(release_forge)" in
        github) echo "  (no token: set COLLIE_TOKEN, or run \`gh auth login --hostname $(release_host)\`)" >&2 ;;
        *) echo "  (no token: set COLLIE_TOKEN, or run \`glab auth login --hostname $(release_host)\`)" >&2 ;;
      esac
    fi
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
  if needs_build; then
    echo "building from source: $ROOT is a checkout, and its source is what a release is cut from"
    build_from_source
  else
    echo "bin/collie is newer than everything it is built from; nothing to build"
  fi
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

# The runner is one step of preparing a machine; the rest of it — the plugin link,
# the operator skill, the skills the workflows require — is `prepare.sh`, so that a
# plugin rebuilt through herdr's build hook is a complete installation and not just
# a fresh binary. Skipped when this is already running inside `prepare.sh`, which is
# what stops the two from calling each other round in a circle.
if [ "${COLLIE_PREPARING:-}" != "1" ]; then
  COLLIE_RUNNER_FRESH=1 sh "$ROOT/prepare.sh"
fi

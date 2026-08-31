#!/bin/sh
# Fetches the prebuilt runner for this platform so consumers don't need bun.
# Falls back to building from source when bun happens to be available, which is
# only the case on a machine developing the plugin itself.
set -eu

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' herdr-plugin.toml)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
esac

ASSET="collie-${OS}-${ARCH}"
BASE="${COLLIE_RELEASE_BASE:-https://gitlab.cego.dk/mk/collie/-/releases/v${VERSION}/downloads}"

mkdir -p bin
if curl -fsSL "${BASE}/${ASSET}" -o bin/collie.new 2>/dev/null; then
  mv bin/collie.new bin/collie
  chmod +x bin/collie
  echo "installed ${ASSET} from ${BASE}"
  exit 0
fi
rm -f bin/collie.new

if command -v bun >/dev/null 2>&1; then
  echo "no release asset at ${BASE}/${ASSET}; building from source with bun"
  bun install --frozen-lockfile >/dev/null
  # Build beside the binary and rename over it: replacing a running runner's own
  # file in place kills the process executing it.
  bun build --compile --outfile bin/collie.new src/main.ts >/dev/null
  mv -f bin/collie.new bin/collie
  exit 0
fi

echo "cannot install: no ${ASSET} at ${BASE} and no bun to build from source" >&2
exit 1

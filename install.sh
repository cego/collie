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

ASSET="herdr-workflows-${OS}-${ARCH}"
BASE="${HERDR_WORKFLOWS_RELEASE_BASE:-https://gitlab.cego.dk/cego/herdr-plugin/-/releases/v${VERSION}/downloads}"

mkdir -p bin
if curl -fsSL "${BASE}/${ASSET}" -o bin/herdr-workflows.new 2>/dev/null; then
  mv bin/herdr-workflows.new bin/herdr-workflows
  chmod +x bin/herdr-workflows
  echo "installed ${ASSET} from ${BASE}"
  exit 0
fi
rm -f bin/herdr-workflows.new

if command -v bun >/dev/null 2>&1; then
  echo "no release asset at ${BASE}/${ASSET}; building from source with bun"
  bun install --frozen-lockfile >/dev/null
  bun build --compile --outfile bin/herdr-workflows src/main.ts >/dev/null
  exit 0
fi

echo "cannot install: no ${ASSET} at ${BASE} and no bun to build from source" >&2
exit 1

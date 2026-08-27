#!/bin/sh
# Fetches the prebuilt runner for this platform so consumers don't need bun.
set -eu
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' herdr-plugin.toml)
OS=$(uname -s | tr '[:upper:]' '[:lower:]'); ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; esac
URL="https://gitlab.cego.dk/cego/herdr-plugin/-/releases/v${VERSION}/downloads/herdr-workflows-${OS}-${ARCH}"
mkdir -p bin
curl -fsSL "$URL" -o bin/herdr-workflows
chmod +x bin/herdr-workflows

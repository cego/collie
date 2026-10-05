#!/bin/sh
# Installs Collie Desktop for this user, with a desktop entry:
#
#   curl -fsSL https://github.com/cego/collie/releases/latest/download/install-desktop.sh | sh
#
# It downloads the latest release's Electrobun installer and runs it once the download
# verifies against Collie's release key; one that does not is never run. Desktop keeps
# itself up to date from then on.
set -eu

BASE="${COLLIE_DESKTOP_BASE:-https://github.com/cego/collie/releases/latest/download}"

case "$(uname -s)" in
  Linux) ;;
  *) echo "Collie Desktop is released for Linux only" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  *) echo "Collie Desktop is released for x64 only, not $(uname -m)" >&2; exit 1 ;;
esac
ASSET="linux-${ARCH}-collie-desktop-Setup.tar.gz"

# `release.pub`, inline because this script runs on its own: the key Collie's runners and
# Desktop's updates are checked with too.
RELEASE_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlSUFdwz8026yxgOEch+qYQSblnjqUa3wMU2Yk0edBRY=
-----END PUBLIC KEY-----'

# An OpenSSL that can check an Ed25519 signature: 3.0 or later. The check is install.sh's,
# copied because this script has nothing beside it to share it from.
verifier() {
  for candidate in ${COLLIE_OPENSSL:-openssl openssl3}; do
    case "$("$candidate" version 2>/dev/null)" in
      "OpenSSL "[3-9]* | "OpenSSL "[1-9][0-9]*) echo "$candidate"; return 0 ;;
    esac
  done
  return 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! curl -fsSL "${BASE}/${ASSET}" -o "$work/setup.tar.gz" 2>/dev/null; then
  echo "could not download ${BASE}/${ASSET}" >&2
  exit 1
fi
if ! curl -fsSL "${BASE}/${ASSET}.sig" -o "$work/setup.sig" 2>/dev/null; then
  echo "could not fetch ${BASE}/${ASSET}.sig to check the download, so it was not installed" >&2
  exit 1
fi
if ! openssl=$(verifier); then
  echo "no OpenSSL 3.0 or later to check ${ASSET}'s signature with, so it was not installed" >&2
  exit 1
fi
printf '%s\n' "$RELEASE_KEY" > "$work/release.pub"
"$openssl" base64 -d -A -in "$work/setup.sig" -out "$work/setup.sig.bin" 2>/dev/null || : > "$work/setup.sig.bin"
if ! said=$("$openssl" pkeyutl -verify -pubin -inkey "$work/release.pub" -rawin \
  -in "$work/setup.tar.gz" -sigfile "$work/setup.sig.bin" 2>&1); then
  case "$said" in
    *"Signature Verification Failure"*) echo "${BASE}/${ASSET} does not match its signature from Collie's release key, so it was not installed" >&2 ;;
    *) echo "$openssl could not check ${ASSET}'s signature, so it was not installed: $said" >&2 ;;
  esac
  exit 1
fi

tar -xzf "$work/setup.tar.gz" -C "$work" ./installer
# Electrobun's installer: per user, under ~/.local/share, with a desktop entry.
"$work/installer"
echo "installed Collie Desktop from ${BASE}"

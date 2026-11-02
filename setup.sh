#!/bin/sh
# Installs Collie for this user, or brings an install up to date:
#
#   curl -fsSL https://github.com/cego/collie/releases/latest/download/setup.sh | sh
#
# It downloads the runner for this platform, verifies it against Collie's release key, and has
# it place the release it carries into the Collie directory, migrating a clone found there.
# Then the first-time work: the status line and `collie doctor`.
# Safe to re-run; every step skips what is already in place.
set -eu

RELEASES="${COLLIE_RELEASES:-https://github.com/cego/collie/releases}"
COLLIE_DIR="${COLLIE_DIR:-$HOME/.collie}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

command -v herdr >/dev/null 2>&1 || die "herdr is not installed — see https://herdr.dev/docs/install/"
command -v curl >/dev/null 2>&1 || die "curl is required"
openssl=${COLLIE_OPENSSL:-openssl}
"$openssl" version >/dev/null 2>&1 || die "openssl is required, to check the download's signature"

VERSION="${COLLIE_VERSION:-}"
if [ -n "$VERSION" ]; then
  printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "not a Collie release version: $VERSION"
  BASE="$RELEASES/download/$VERSION"
else
  BASE="$RELEASES/latest/download"
fi
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) ARCH=$(uname -m) ;;
esac
ASSET="collie-${OS}-${ARCH}"

# `release-p256.pub`, inline because this script runs on its own.
RELEASE_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETnwpL6PxMua037RtVs/Op9NkxSch
DEYreTviEHJTXMq+jbDAWxybnz9wpd9nseh9waYk8QvKMjQM62bag6M7sA==
-----END PUBLIC KEY-----'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# So a ^C or a kill runs the EXIT trap too, which sh does not do by itself.
trap 'exit 1' INT TERM

say "Downloading ${ASSET}"
curl -fsSL "${BASE}/${ASSET}" -o "$work/collie" 2>/dev/null || die "could not download ${BASE}/${ASSET}"
curl -fsSL "${BASE}/${ASSET}.p256.sig" -o "$work/collie.sig" 2>/dev/null ||
  die "could not fetch ${BASE}/${ASSET}.p256.sig to check the download, so nothing was installed"
printf '%s\n' "$RELEASE_KEY" > "$work/release.pub"
"$openssl" base64 -d -A -in "$work/collie.sig" -out "$work/collie.sig.bin" 2>/dev/null || : > "$work/collie.sig.bin"
"$openssl" dgst -sha256 -verify "$work/release.pub" -signature "$work/collie.sig.bin" "$work/collie" >/dev/null 2>&1 ||
  die "${BASE}/${ASSET} does not match its signature from Collie's release key, so nothing was installed"
case "$(od -An -tx1 -N4 "$work/collie" | tr -d ' \n')" in
  7f454c46 | cffaedfe | cefaedfe | cafebabe | bebafeca) chmod +x "$work/collie" ;;
  *) die "${BASE}/${ASSET} is not a program, so nothing was installed" ;;
esac

# A clone there is an install from before releases were placed: upgrade migrates it.
if [ -e "$COLLIE_DIR/.git" ]; then plugin_root="$COLLIE_DIR"; else plugin_root="$COLLIE_DIR/release"; fi
say "Placing Collie into $COLLIE_DIR"
COLLIE_DIR="$COLLIE_DIR" HERDR_PLUGIN_ROOT="$plugin_root" COLLIE_RELEASES="$RELEASES" \
  "$work/collie" upgrade ${VERSION:+--to "$VERSION"} || die "the runner did not place its release"
ROOT="$COLLIE_DIR/release"

# The line under the chat prompt, in the human's own Claude Code settings: first-time
# work, never `prepare.sh`'s. The runner edits the file so that everything else the
# human keeps there survives it, and says what it did.
say "Configuring Claude Code's status line"
"$ROOT/bin/collie" chat status-line --install || say "Could not configure the status line; collie doctor says what to do"

say "Done."
say "The Collie host keeps two core terminals: the board, collie-board, and chat about"
say "the flock, collie-chat: hc attach collie-board opens the board."
say "The collie skill lets an agent drive runs from the CLI."

# The last word, and the exit status: either everything is ready or what is missing
# with the command that fixes each one. `exec`, so nothing here can print after it
# and finishing means verified rather than asserted.
say "Checking prerequisites"
exec "$ROOT/bin/collie" doctor

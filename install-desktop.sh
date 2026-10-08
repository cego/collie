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

# `release-p256.pub`, inline because this script runs on its own: the key install.sh checks a
# runner with too.
RELEASE_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETnwpL6PxMua037RtVs/Op9NkxSch
DEYreTviEHJTXMq+jbDAWxybnz9wpd9nseh9waYk8QvKMjQM62bag6M7sA==
-----END PUBLIC KEY-----'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! curl -fsSL "${BASE}/${ASSET}" -o "$work/setup.tar.gz" 2>/dev/null; then
  echo "could not download ${BASE}/${ASSET}" >&2
  exit 1
fi
if ! curl -fsSL "${BASE}/${ASSET}.p256.sig" -o "$work/setup.sig" 2>/dev/null; then
  echo "could not fetch ${BASE}/${ASSET}.p256.sig to check the download, so it was not installed" >&2
  exit 1
fi
openssl=${COLLIE_OPENSSL:-openssl}
if ! "$openssl" version >/dev/null 2>&1; then
  echo "no $openssl to check ${ASSET}'s signature with, so it was not installed" >&2
  exit 1
fi
printf '%s\n' "$RELEASE_KEY" > "$work/release.pub"
"$openssl" base64 -d -A -in "$work/setup.sig" -out "$work/setup.sig.bin" 2>/dev/null || : > "$work/setup.sig.bin"
if ! "$openssl" dgst -sha256 -verify "$work/release.pub" \
  -signature "$work/setup.sig.bin" "$work/setup.tar.gz" >/dev/null 2>&1; then
  echo "${BASE}/${ASSET} does not match its signature from Collie's release key, so it was not installed" >&2
  exit 1
fi

tar -xzf "$work/setup.tar.gz" -C "$work" ./installer
# Electrobun's installer: per user, under ~/.local/share, with a desktop entry.
"$work/installer"
echo "installed Collie Desktop from ${BASE}"

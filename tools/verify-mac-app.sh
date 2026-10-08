#!/bin/sh
# Every app bundle a macOS Desktop build in DIR made passes `codesign --verify --deep --strict`:
# the one the DMG carries, and the one each update archive unpacks to, which is what runs.
set -eu

DIR=$1
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for archive in "$DIR"/artifacts/*.app.tar.zst; do
  [ -f "$archive" ] || continue
  mkdir "$work/${archive##*/}"
  bun -e 'await Bun.write(Bun.argv[2], Bun.zstdDecompressSync(await Bun.file(Bun.argv[1]).bytes()))' \
    "$archive" "$work/payload.tar"
  tar -xf "$work/payload.tar" -C "$work/${archive##*/}"
done

found=0
for app in "$DIR"/build/*/*.app "$work"/*/*.app; do
  [ -d "$app" ] || continue
  codesign --verify --deep --strict --verbose=2 "$app"
  found=$((found + 1))
done
[ "$found" -gt 1 ] || { echo "found $found app bundle(s) in $DIR; wanted the DMG's and an update archive's" >&2; exit 1; }
echo "verified $found app bundles in $DIR"

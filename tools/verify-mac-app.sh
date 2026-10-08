#!/bin/sh
# Every app bundle Electrobun built under DIR passes `codesign --verify --deep --strict`, and
# there is at least one.
set -eu

found=0
for app in "$1"/*/*.app "$1"/*.app; do
  [ -d "$app" ] || continue
  codesign --verify --deep --strict --verbose=2 "$app"
  found=$((found + 1))
done
[ "$found" -gt 0 ] || { echo "no app bundle under $1" >&2; exit 1; }
echo "verified $found app bundle(s) under $1"

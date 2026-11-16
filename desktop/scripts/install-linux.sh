#!/bin/sh
# The signed setup archive carries this installer beside the native Collie bundle.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data=${XDG_DATA_HOME:-"$HOME/.local/share"}
case "$data" in /*) ;; *) data="$HOME/.local/share" ;; esac
[ "$data" != / ] || data="$HOME/.local/share"
root="$data/dk.cego.collie.desktop/stable"
mkdir -p "$root" "$data/applications"
work=$(mktemp -d "$root/.install-XXXXXX")
cleanup() {
  if [ ! -d "$root/app" ] && [ -d "$work/previous" ]; then
    mv "$work/previous" "$root/app"
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
cp -R "$source_dir/collie-desktop" "$work/app"
test -x "$work/app/bin/launcher"
test -x "$work/app/bin/collie-core"
test -f "$work/app/Resources/version.json"
# Stage the entry before moving the previous app, including paths containing spaces.
escape_entry() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g'; }
launcher=$(escape_entry "$root/app/bin/launcher")
icon=$(escape_entry "$root/app/Resources/appIcon.png")
cat > "$work/entry" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Collie
Exec="$launcher"
Icon=$icon
Terminal=false
StartupWMClass=collie-desktop
Categories=Development;
EOF
if [ -d "$root/app" ]; then mv "$root/app" "$work/previous"; fi
mv "$work/app" "$root/app"
mv "$work/entry" "$data/applications/collie-desktop.desktop"
echo "installed Collie"

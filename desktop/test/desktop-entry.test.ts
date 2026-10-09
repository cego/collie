// The launcher entry's name and comment, and the macOS bundle's name, as people see them.

import { expect, test } from "bun:test";
import { withCollieBundleName, withCollieName } from "../src/desktop-entry";

const built = `[Desktop Entry]
Version=1.0
Type=Application
Name=collie-desktop
Comment=collie-desktop
Exec=launcher
Icon=appIcon
Terminal=false
StartupWMClass=collie-desktop
Categories=Utility;
`;

test("the entry's name and comment say Collie, and the window class stays the build name", () => {
  expect(withCollieName(built, "collie-desktop")).toBe(`[Desktop Entry]
Version=1.0
Type=Application
Name=Collie
Comment=Collie
Exec=launcher
Icon=appIcon
Terminal=false
StartupWMClass=collie-desktop
Categories=Utility;
`);
});

test("a channel's suffix is kept, so a dev build is told apart", () => {
  expect(withCollieName("Name=collie-desktop (Development)\n", "collie-desktop")).toBe(
    "Name=Collie (Development)\n",
  );
});

test("a macOS bundle's name says Collie, and its identifier and executable stay the build's", () => {
  const plist = `<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>dk.cego.collie.desktop</string>
    <key>CFBundleName</key>
    <string>collie-desktop-dev</string>
</dict>`;
  expect(withCollieBundleName(plist, "collie-desktop")).toBe(
    plist.replace("<string>collie-desktop-dev</string>", "<string>Collie-dev</string>"),
  );
});

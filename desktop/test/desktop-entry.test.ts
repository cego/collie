// The launcher entry's name and comment, as people see them.

import { expect, test } from "bun:test";
import { withCollieName } from "../src/desktop-entry";

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

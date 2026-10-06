// The launcher entry Electrobun writes names the app by its build name; people see Collie.

import { expect, test } from "bun:test";
import { asShown } from "../src/desktop-entry";

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
  expect(asShown(built, "collie-desktop")).toBe(`[Desktop Entry]
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
  expect(asShown("Name=collie-desktop (Development)\n", "collie-desktop")).toBe(
    "Name=Collie (Development)\n",
  );
});

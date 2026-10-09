// The application menu a Mac needs: macOS sends Cmd+C, Cmd+V, Cmd+Q and the rest through it.

import type { ApplicationMenuItemConfig } from "electrobun/bun";

const role = (name: string): ApplicationMenuItemConfig => ({ role: name });
const separator: ApplicationMenuItemConfig = { type: "separator" };

/** The menus Desktop sets on `platform`; none anywhere but macOS, where Linux has no menu bar. */
export const applicationMenu = (platform: string): ApplicationMenuItemConfig[] =>
  platform !== "darwin"
    ? []
    : [
        {
          label: "Collie",
          submenu: [
            role("about"),
            separator,
            role("hide"),
            role("hideOthers"),
            role("showAll"),
            separator,
            role("quit"),
          ],
        },
        {
          label: "Edit",
          submenu: [
            role("undo"),
            role("redo"),
            separator,
            role("cut"),
            role("copy"),
            role("paste"),
            role("pasteAndMatchStyle"),
            role("selectAll"),
          ],
        },
        {
          label: "Window",
          submenu: [role("minimize"), role("zoom"), role("close")],
        },
      ];

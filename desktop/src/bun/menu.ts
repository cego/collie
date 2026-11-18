import type { ApplicationMenuItemConfig } from "../../core/platform";

const role = (name: string) => ({ role: name });
const separator: ApplicationMenuItemConfig = { type: "separator" };

export const applicationMenu = (platform: string) =>
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

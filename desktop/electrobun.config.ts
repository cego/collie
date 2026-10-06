import type { ElectrobunConfig } from "electrobun";
import manifest from "../herdr-plugin.toml";

// A port here opens CEF's debugging protocol on it, so Playwright can drive the built app.
const cdp = Bun.env.COLLIE_DESKTOP_CDP;

export default {
  app: {
    // Names the artifacts installed Desktops update from; people see Collie instead.
    name: "collie-desktop",
    identifier: "dk.cego.collie.desktop",
    // Released with Collie, under the same tag and version.
    version: manifest.version,
  },
  release: { baseUrl: "https://github.com/cego/collie/releases/latest/download" },
  scripts: { postBuild: "src/desktop-entry.ts", postWrap: "src/desktop-entry.ts" },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: { "view/.output/public": "views/mainview" },
    watchIgnore: ["view/**"],
    mac: { bundleCEF: false },
    linux: {
      bundleCEF: true,
      // bundleCEF alone still renders with WebKitGTK.
      defaultRenderer: "cef",
      // The launcher entry's icon and every window's.
      icon: "../assets/brand/logos/collie-mark-256.png",
      chromiumFlags: cdp === undefined ? {} : { "remote-debugging-port": cdp },
    },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;

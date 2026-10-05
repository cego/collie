import type { ElectrobunConfig } from "electrobun";
import manifest from "../herdr-plugin.toml";

// A port here opens CEF's debugging protocol on it, so Playwright can drive the built app.
const cdp = Bun.env.COLLIE_DESKTOP_CDP;

export default {
  app: {
    name: "collie-desktop",
    identifier: "dk.cego.collie.desktop",
    // Released with Collie, under the same tag and version.
    version: manifest.version,
  },
  release: { baseUrl: "https://github.com/cego/collie/releases/latest/download" },
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
      chromiumFlags: cdp === undefined ? {} : { "remote-debugging-port": cdp },
    },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;

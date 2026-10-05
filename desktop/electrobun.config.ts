import type { ElectrobunConfig } from "electrobun";

// A port here opens CEF's debugging protocol on it, so Playwright can drive the built app.
const cdp = Bun.env.COLLIE_DESKTOP_CDP;

export default {
  app: {
    name: "collie-desktop",
    identifier: "dk.cego.collie.desktop",
    version: "0.0.0",
  },
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

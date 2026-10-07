import type { ElectrobunConfig } from "electrobun";
import manifest from "../herdr-plugin.toml";

export default {
  app: {
    // Names the update archives; scripts/name-desktop-entry.ts sets what people see.
    name: "collie-desktop",
    identifier: "dk.cego.collie.desktop",
    // Released with Collie, under the same tag and version.
    version: manifest.version,
  },
  release: { baseUrl: "https://github.com/cego/collie/releases/latest/download" },
  scripts: {
    postBuild: "scripts/name-desktop-entry.ts",
    postWrap: "scripts/name-desktop-entry.ts",
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
      // The launcher entry's icon and every window's.
      icon: "../assets/brand/logos/collie-mark-256.png",
    },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;

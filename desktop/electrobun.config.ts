import type { ElectrobunConfig } from "electrobun";
import manifest from "../herdr-plugin.toml";
import { macSigning } from "./scripts/mac-signing";

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
    preBuild: "scripts/mac-icons.ts",
    postBuild: "scripts/name-desktop-entry.ts",
    postWrap: "scripts/name-desktop-entry.ts",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: { "view/.output/public": "views/mainview" },
    watchIgnore: ["view/**"],
    mac: {
      bundleCEF: false,
      icons: "mac.iconset",
      ...macSigning(process.env),
      // Electrobun signs with the hardened runtime, which Bun's JIT and an ad hoc identity's
      // libraries need these to run under.
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        "com.apple.security.cs.disable-executable-page-protection": true,
        "com.apple.security.cs.allow-dyld-environment-variables": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
    },
    linux: {
      bundleCEF: true,
      // bundleCEF alone still renders with WebKitGTK.
      defaultRenderer: "cef",
      // The launcher entry's icon and every window's.
      icon: "../assets/brand/logos/collie-tile-256.png",
    },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;

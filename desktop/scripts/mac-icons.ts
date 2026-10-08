// Electrobun's preBuild hook: the macOS app's icon set, made from the brand tile with sips.

import { mkdirSync } from "node:fs";

const SOURCE = `${import.meta.dir}/../../assets/brand/logos/collie-tile-512.png`;
// What electrobun.config.ts names as `mac.icons`.
const ICONSET = `${import.meta.dir}/../mac.iconset`;
const SIZES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
] as const;

if (process.env.ELECTROBUN_OS === "macos") {
  mkdirSync(ICONSET, { recursive: true });
  for (const [name, size] of SIZES) {
    const made = Bun.spawnSync([
      "sips",
      "-z",
      `${size}`,
      `${size}`,
      SOURCE,
      "--out",
      `${ICONSET}/${name}`,
    ]);
    if (made.exitCode !== 0) throw new Error(`sips could not make ${name}: ${made.stderr}`);
  }
}

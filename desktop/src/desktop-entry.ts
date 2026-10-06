// Electrobun's postBuild and postWrap hook. Its launcher entry is named by `app.name`, which
// also names the update archives that installed Desktops fetch, so the name people see is
// changed here instead.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `entry` with its Name and Comment saying Collie rather than the build's `name`. */
export const asShown = (entry: string, name: string) =>
  entry.replace(/^(Name|Comment)=.*$/gm, (line) => line.replace(name, "Collie"));

const dir = process.env.ELECTROBUN_BUILD_DIR;
const name = process.env.ELECTROBUN_APP_NAME;
if (dir !== undefined && name !== undefined) {
  for (const bundle of readdirSync(dir, { withFileTypes: true })) {
    if (!bundle.isDirectory()) continue;
    for (const file of readdirSync(join(dir, bundle.name))) {
      if (!file.endsWith(".desktop")) continue;
      const path = join(dir, bundle.name, file);
      writeFileSync(path, asShown(readFileSync(path, "utf8"), name));
    }
  }
}

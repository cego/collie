// Electrobun's postBuild and postWrap hook: `app.name` also names the update archives, so
// the launcher entry is renamed here instead.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCollieName } from "../src/desktop-entry";

const dir = process.env.ELECTROBUN_BUILD_DIR;
const name = process.env.ELECTROBUN_APP_NAME;
if (dir === undefined || name === undefined) {
  throw new Error("ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME must be set");
}
let renamed = 0;
for (const bundle of readdirSync(dir, { withFileTypes: true })) {
  if (!bundle.isDirectory()) continue;
  for (const file of readdirSync(join(dir, bundle.name))) {
    if (!file.endsWith(".desktop")) continue;
    const path = join(dir, bundle.name, file);
    writeFileSync(path, withCollieName(readFileSync(path, "utf8"), name));
    renamed++;
  }
}
if (renamed === 0) throw new Error(`no desktop entry under ${dir} to name Collie`);

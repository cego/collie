// Electrobun's postBuild and postWrap hook: `app.name` also names the update archives, so
// the launcher entry on Linux, and the app bundle's name on macOS, are renamed here instead.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCollieBundleName, withCollieName } from "../src/desktop-entry";

const dir = process.env.ELECTROBUN_BUILD_DIR;
const name = process.env.ELECTROBUN_APP_NAME;
if (dir === undefined || name === undefined) {
  throw new Error("ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME must be set");
}
const rename = (path: string, as: (text: string, name: string) => string) =>
  writeFileSync(path, as(readFileSync(path, "utf8"), name));
let renamed = 0;
for (const bundle of readdirSync(dir, { withFileTypes: true })) {
  if (!bundle.isDirectory()) continue;
  if (bundle.name.endsWith(".app")) {
    rename(join(dir, bundle.name, "Contents", "Info.plist"), withCollieBundleName);
    renamed++;
    continue;
  }
  for (const file of readdirSync(join(dir, bundle.name))) {
    if (!file.endsWith(".desktop")) continue;
    rename(join(dir, bundle.name, file), withCollieName);
    renamed++;
  }
}
if (renamed === 0) throw new Error(`no desktop entry or app bundle under ${dir} to name Collie`);

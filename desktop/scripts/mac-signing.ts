import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every name in `names` set and not empty. */
const has = (env: Record<string, string | undefined>, ...names: string[]) =>
  names.every((name) => (env[name] ?? "") !== "");

/**
 * Whether Electrobun signs the macOS build with a Developer ID and notarizes it: only with the
 * identity and a complete set of notarization credentials, else it is signed ad hoc.
 */
export const macSigning = (env: Record<string, string | undefined>) => {
  const on =
    has(env, "ELECTROBUN_DEVELOPER_ID") &&
    (has(env, "ELECTROBUN_APPLEID", "ELECTROBUN_APPLEIDPASS", "ELECTROBUN_TEAMID") ||
      has(
        env,
        "ELECTROBUN_APPLEAPIKEY",
        "ELECTROBUN_APPLEAPIISSUER",
        "ELECTROBUN_APPLEAPIKEYPATH",
      ));
  return { codesign: on, notarize: on };
};

/** The app bundles directly under `dir`. */
export const appsIn = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".app"))
    .map((name) => join(dir, name));

/** Signs `app` ad hoc where `codesign --verify` rejects it, so macOS will start it. */
export const signAdHocWhereUnsigned = (app: string) => {
  if (!existsSync(app)) return;
  if (Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", app]).exitCode === 0) return;
  const signed = Bun.spawnSync(["codesign", "--force", "--deep", "--sign", "-", app]);
  if (signed.exitCode !== 0) throw new Error(`could not sign ${app} ad hoc: ${signed.stderr}`);
};

// The hc a placed release carries, put where upstream's installer puts it
// (https://releases.herdr.dev/core/install.sh): `herdr-core` in `~/.local/bin`, with `hc`
// beside it only where no `hc` exists. One already there is swapped with
// `hc update --from`, so its running terminals survive.

import * as Str from "effect/String";
import { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { onPath } from "./doctor-check";
import type { Runner } from "./mr";

/** Where a release keeps its hc archive, relative to the release. */
export const BUNDLED_HC = "hc/herdr-core.tar.gz";

/** Upstream's `HC_INSTALL_DIR`, else `~/.local/bin`. */
export const hcInstallDir = (raw: Readonly<Record<string, string | undefined>>, home: string) =>
  raw.HC_INSTALL_DIR || `${home}/.local/bin`;

export interface HcStep {
  readonly step: "hc";
  readonly state: "done" | "already in place" | "failed";
  readonly detail: string;
}

/**
 * Installs the hc that the release at `root` carries, or swaps it in where the release it
 * replaced carried another archive (`was`, its recorded sha256, null where it carried none).
 * Null where the release carries no hc.
 */
export const placeHc = Effect.fn("HcInstall.place")(function* (
  env: { readonly raw: Readonly<Record<string, string | undefined>>; readonly home: string },
  root: string,
  was: string | null,
  is: string | null,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = path.join(root, BUNDLED_HC);
  if (is === null || !(yield* fs.exists(archive))) return null;
  const bin = hcInstallDir(env.raw, env.home);
  const installed = path.join(bin, "herdr-core");
  const present = yield* fs.exists(installed);
  if (present && was === is)
    return { step: "hc", state: "already in place", detail: installed } satisfies HcStep;

  const failed = (detail: string): HcStep => ({ step: "hc", state: "failed", detail });
  const unpacked = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hc-" });
  const untar = yield* run("tar", ["-xzf", archive, "-C", unpacked, "herdr-core"], root);
  if (untar.code !== 0)
    return failed(`could not unpack ${archive}: ${Str.trim(untar.stderr ?? "")}`);
  const carried = path.join(unpacked, "herdr-core");

  if (present) {
    const updated = yield* run(installed, ["update", "--from", carried], root);
    return updated.code === 0
      ? ({ step: "hc", state: "done", detail: `updated ${installed}` } satisfies HcStep)
      : failed(
          `${installed} update --from the carried hc: ${Str.trim(updated.stderr ?? "") || Str.trim(updated.stdout) || `exit ${updated.code}`}`,
        );
  }
  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.copyFile(carried, `${installed}.new`);
  yield* fs.chmod(`${installed}.new`, 0o755);
  yield* fs.rename(`${installed}.new`, installed);
  const hc = path.join(bin, "hc");
  const taken =
    (yield* onPath(env.raw.PATH ?? "", "hc")) !== null ||
    (yield* fs.readLink(hc).pipe(
      Effect.as(true),
      Effect.catch(() => fs.exists(hc)),
    ));
  if (!taken) yield* fs.symlink("herdr-core", hc);
  return { step: "hc", state: "done", detail: `installed ${installed}` } satisfies HcStep;
}, Effect.scoped);

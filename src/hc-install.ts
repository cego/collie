import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { answered, onPath } from "./doctor-check";
import type { Runner } from "./mr";

const IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-${IDENTIFIER}(?:\.${IDENTIFIER})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

export const hcVersion = (said: string) => {
  const word = Arr.findFirst(Str.split(said, /\s+/), (one) => /^\d/.test(one));
  if (Option.isNone(word)) {
    return null;
  }
  const parts = SEMVER.exec(word.value);
  return parts !== null && Arr.every(parts.slice(1, 4), (n) => Number.isSafeInteger(Number(n)))
    ? word.value
    : null;
};

// WARNING: A prerelease is older than its release; output naming no version does not meet min.
export const hcMeets = (said: string, min: string) => {
  const version = hcVersion(said);
  return version !== null && Bun.semver.order(version, min) >= 0;
};

export const BUNDLED_HC = "hc/herdr-core.tar.gz";

export const hcInstallDir = (raw: Readonly<Record<string, string | undefined>>, home: string) =>
  raw.HC_INSTALL_DIR || `${home}/.local/bin`;

export interface HcStep {
  readonly step: "hc";
  readonly state: "done" | "already in place" | "failed";
  readonly detail: string;
}

const PLACED_HC = "hc-placed.sha256";

// WARNING: Swapped with `hc update --from`, not overwritten, so its running terminals survive.
export const placeHc = Effect.fn("HcInstall.place")(function* (
  env: {
    readonly raw: Readonly<Record<string, string | undefined>>;
    readonly home: string;
    readonly collieDir: string;
  },
  root: string,
  is: string | null,
  min: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = path.join(root, BUNDLED_HC);
  if (is === null || !(yield* fs.exists(archive))) {
    return null;
  }
  const bin = hcInstallDir(env.raw, env.home);
  const installed = path.join(bin, "herdr-core");
  const present = yield* fs.exists(installed);
  const record = path.join(env.collieDir, PLACED_HC);
  const placed = yield* fs.readFileString(record).pipe(Effect.orElseSucceed(() => ""));
  if (present && Str.trim(placed) === is) {
    return { step: "hc", state: "already in place", detail: installed } satisfies HcStep;
  }
  if (present) {
    const said = (yield* answered(run(installed, ["--version"], root))).stdout;
    if (hcMeets(said, min)) {
      return {
        step: "hc",
        state: "already in place",
        detail: `${installed}, hc ${hcVersion(said)}, not older than the ${min} this release carries`,
      } satisfies HcStep;
    }
  }

  const failed = (detail: string) => ({ step: "hc", state: "failed", detail });
  const unpacked = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hc-" });
  const untar = yield* run("tar", ["-xzf", archive, "-C", unpacked, "herdr-core"], root);
  if (untar.code !== 0) {
    return failed(`could not unpack ${archive}: ${Str.trim(untar.stderr ?? "")}`);
  }
  const carried = path.join(unpacked, "herdr-core");

  if (present) {
    const updated = yield* run(installed, ["update", "--from", carried], root);
    if (updated.code !== 0) {
      return failed(
        `${installed} update --from the carried hc: ${Str.trim(updated.stderr ?? "") || Str.trim(updated.stdout) || `exit ${updated.code}`}`,
      );
    }
    yield* fs.writeFileString(record, `${is}\n`);
    return { step: "hc", state: "done", detail: `updated ${installed}` } satisfies HcStep;
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
  if (!taken) {
    yield* fs.symlink("herdr-core", hc);
  }
  yield* fs.writeFileString(record, `${is}\n`);
  return { step: "hc", state: "done", detail: `installed ${installed}` } satisfies HcStep;
}, Effect.scoped);

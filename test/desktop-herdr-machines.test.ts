// Desktop's list of Machines is herdr's, and a herdr too old to keep one is told apart from
// one that failed for any other reason.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Result } from "effect";
import { herdrMachines } from "../desktop/src/bun/machine";
import { runEffect } from "./support/effect";

/** Why `herdr machine list` failed, as Desktop shows it, for a herdr `version` that says `said` and exits 2. */
const reasonFor = (version: string, said: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const herdr = `${yield* fs.makeTempDirectoryScoped()}/herdr`;
    yield* fs.writeFileString(
      herdr,
      `#!/bin/sh\ncase "$1" in --version) echo "herdr ${version}" ;; *) echo "${said}" >&2; exit 2 ;; esac\n`,
    );
    yield* fs.chmod(herdr, 0o755);
    const listed = yield* herdrMachines(herdr, "0.9.3").pipe(Effect.result);
    return Result.isFailure(listed) ? listed.failure : "listed";
  }).pipe(Effect.scoped);

test("a herdr with no `machine` command is named, with what Collie needs and where to look", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reasonFor("0.7.1", "error: unrecognized subcommand 'machine'")).toBe(
        "herdr 0.7.1 has no `herdr machine`; Collie needs 0.9.3 — run `collie doctor` on this computer",
      );
    }),
  ));

test("a herdr new enough to have machines keeps its own words when it fails", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reasonFor("0.9.3", "cannot read machines.toml")).toBe(
        "cannot read machines.toml",
      );
    }),
  ));

test("a herdr below the pin that fails for another reason keeps its own words", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reasonFor("0.9.2", "cannot read machines.toml: permission denied")).toBe(
        "cannot read machines.toml: permission denied",
      );
    }),
  ));

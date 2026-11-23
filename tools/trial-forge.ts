// Serves the test fake GitLab outside the test runner, for a trial's host, until killed:
// `glab` in <dir>, and the URL to give the host as COLLIE_FORGE_API in <dir>/api.
//   bun run tools/trial-forge.ts <dir> <origins>
// Project gitlab.example.com/trial/<name> is pushed to <origins>/<name>.git. Each open merge
// request follows its source branch there, and its pipeline passes.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { FakeBin } from "../test/support/bin";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";
import {
  FORGE_HOST,
  ForgeModel,
  forgeOnPath,
  serveForges,
  type FakeMr,
} from "../test/support/forge";

const [dir, origins] = Bun.argv.slice(2);
if (dir === undefined || origins === undefined)
  throw new Error("usage: trial-forge.ts <dir> <origins>");
const PROJECTS = `${FORGE_HOST.gitlab}/trial/`;
const originOf = (project: string) =>
  pipe(project, Str.startsWith(PROJECTS))
    ? `${origins}/${pipe(project, Str.slice(PROJECTS.length))}.git`
    : undefined;

const branchHead = (origin: string, branch: string) =>
  Effect.map(
    exec(["git", "--git-dir", origin, "rev-parse", "--verify", `refs/heads/${branch}`]),
    (ran) => (ran.exitCode === 0 ? Str.trim(ran.stdout) : null),
  );

const passing = (mr: FakeMr, head: string): FakeMr => ({
  ...mr,
  head,
  jobs: [{ name: "test", state: "passed" }],
  checks: [{ name: "test", state: "passed" }],
});

await runEffect(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(dir);
      const kept = `${dir}/gitlab.model.json`;
      const forge = yield* forgeOnPath(
        bin,
        "gitlab",
        (yield* fs.exists(kept))
          ? yield* Schema.decodeEffect(Schema.fromJsonString(ForgeModel))(
              yield* fs.readFileString(kept),
            )
          : { installed: true, loggedIn: [FORGE_HOST.gitlab], login: "trial", mrs: [] },
      );
      const api = yield* serveForges({ forge: "gitlab", face: forge.face });
      yield* fs.writeFileString(`${dir}/api`, `${api}\n`);
      const follow = Effect.gen(function* () {
        const heads = new Map<string, string>();
        for (const mr of (yield* forge.model()).mrs) {
          const origin = originOf(mr.project);
          if (mr.state !== "open" || origin === undefined || !mr.sourceBranch) continue;
          const head = yield* branchHead(origin, mr.sourceBranch);
          if (head !== null && head !== mr.head) heads.set(`${mr.project}!${mr.iid}`, head);
        }
        if (heads.size === 0) return;
        // Read again, so a write the host made while the heads were read is kept.
        const latest = yield* forge.model();
        yield* forge.set({
          ...latest,
          mrs: Arr.map(latest.mrs, (mr) => {
            const head = heads.get(`${mr.project}!${mr.iid}`);
            return head === undefined ? mr : passing(mr, head);
          }),
        });
      });
      yield* Effect.repeat(follow, Schedule.spaced("3 seconds"));
    }),
  ),
);

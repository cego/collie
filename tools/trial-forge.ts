import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Schema } from "effect";
import { FakeBin } from "../test/support/bin";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";
import { FORGE_HOST, ForgeModel, forgeOnPath, serveForges } from "../test/support/forge";
import type { FakeMr } from "../test/support/forge";

const ModelJson = Schema.fromJsonString(ForgeModel);
const PROJECTS = `${FORGE_HOST.gitlab}/trial/`;
const originOf = (origins: string, project: string) =>
  pipe(project, Str.startsWith(PROJECTS))
    ? `${origins}/${pipe(project, Str.slice(PROJECTS.length))}.git`
    : undefined;

const branchHead = (origin: string, branch: string) =>
  Effect.map(
    exec(["git", "--git-dir", origin, "rev-parse", "--verify", `refs/heads/${branch}`]),
    (ran) => (ran.exitCode === 0 ? Str.trim(ran.stdout) : null),
  );

const passing = (mr: FakeMr, head: string) => {
  const returned: FakeMr = {
    ...mr,
    head,
    jobs: [{ name: "test", state: "passed" }],
    checks: [{ name: "test", state: "passed" }],
  };
  return returned;
};

const headsOf = (model: ForgeModel, origins: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const heads = new Map<string, string>();
      for (const mr of model.mrs) {
        const origin = originOf(origins, mr.project);
        if (mr.state !== "open" || origin === undefined || !mr.sourceBranch) {
          continue;
        }
        const head = yield* branchHead(origin, mr.sourceBranch);
        if (head !== null && head !== mr.head) {
          heads.set(`${mr.project}!${mr.iid}`, head);
        }
      }
      return heads;
    }),
  );

const withHeads = (model: ForgeModel, heads: ReadonlyMap<string, string>) => {
  const returned: ForgeModel = {
    ...model,
    mrs: Arr.map(model.mrs, (mr) => {
      const head = heads.get(`${mr.project}!${mr.iid}`);
      return head === undefined ? mr : passing(mr, head);
    }),
  };
  return returned;
};

export const branchHeads = (origins: string) => (model: ForgeModel) =>
  Effect.orDie(Effect.map(headsOf(model, origins), (heads) => withHeads(model, heads)));

if (import.meta.main) {
  const [dir, origins] = Bun.argv.slice(2);
  if (dir === undefined || origins === undefined) {
    throw new Error("usage: trial-forge.ts <dir> <origins>");
  }
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
            ? yield* Schema.decodeEffect(ModelJson)(yield* fs.readFileString(kept))
            : { installed: true, loggedIn: [FORGE_HOST.gitlab], login: "trial", mrs: [] },
          branchHeads(origins),
        );
        const api = yield* serveForges({ forge: "gitlab", face: forge.face });
        yield* fs.writeFileString(`${dir}/api`, `${api}\n`);
        return yield* Effect.never;
      }),
    ),
  );
}

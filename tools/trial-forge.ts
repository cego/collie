// oxlint-disable-next-line effecttsgo/node-builtin-import -- moveHeads must not yield between its read and write.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { FakeBin } from "../test/support/bin";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";
import { FORGE_HOST, ForgeModel, forgeOnPath, httpFace, serveForges } from "../test/support/forge";
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

export const followingFace = <E>(
  forge: {
    readonly model: () => Effect.Effect<ForgeModel, E>;
    readonly set: (next: ForgeModel) => Effect.Effect<void, E>;
  },
  origins: string,
) =>
  httpFace(
    "gitlab",
    {
      read: Effect.orDie(
        Effect.flatMap(forge.model(), (model) =>
          Effect.map(headsOf(model, origins), (heads) => withHeads(model, heads)),
        ),
      ),
      write: (next) => Effect.orDie(forge.set(next)),
    },
    [],
    [],
  );

const moveHeads = (file: string, heads: ReadonlyMap<string, string>) => {
  // oxlint-disable-next-line effecttsgo/schema-sync -- A yield here would let a write the fake makes for the host be overwritten.
  const moved = withHeads(Schema.decodeSync(ModelJson)(readFileSync(file, "utf8")), heads);
  // oxlint-disable-next-line effecttsgo/schema-sync -- See the read above.
  writeFileSync(`${file}.follow.tmp`, Schema.encodeSync(ModelJson)(moved));
  renameSync(`${file}.follow.tmp`, file);
};

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
        );
        const api = yield* serveForges({ forge: "gitlab", face: followingFace(forge, origins) });
        yield* fs.writeFileString(`${dir}/api`, `${api}\n`);
        const follow = Effect.gen(function* () {
          const heads = yield* headsOf(yield* forge.model(), origins);
          if (heads.size > 0) {
            yield* Effect.sync(() => moveHeads(kept, heads));
          }
        });
        yield* Effect.repeat(follow, Schedule.spaced("3 seconds"));
      }),
    ),
  );
}

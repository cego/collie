import { expect, test } from "bun:test";
import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";
import { followingFace } from "../tools/trial-forge";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { FORGE_HOST, forgeOnPath, tokenOf } from "./support/forge";

const git = (...args: ReadonlyArray<string>) =>
  exec(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]).pipe(
    Effect.map((ran) => Str.trim(ran.stdout)),
  );

test("the forge answers a merge request's head from its branch, even when a writer put an older model back", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "trial-forge-" });
        yield* git("init", "-q", "-b", "feature", `${dir}/work`);
        yield* git("-C", `${dir}/work`, "commit", "-q", "--allow-empty", "-m", "moved");
        yield* git("clone", "-q", "--bare", `${dir}/work`, `${dir}/origins/app.git`);
        const moved = yield* git("-C", `${dir}/work`, "rev-parse", "HEAD");
        const bin = yield* FakeBin.make(`${dir}/bin`);
        const stale = {
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "trial",
          mrs: [
            {
              project: `${FORGE_HOST.gitlab}/trial/app`,
              iid: "1",
              state: "open" as const,
              head: Str.repeat(40)("a"),
              sourceBranch: "feature",
            },
          ],
        };
        const forge = yield* forgeOnPath(bin, "gitlab", stale);
        const face = followingFace(forge, `${dir}/origins`);
        yield* forge.set(stale);
        const answered = yield* Effect.promise(() =>
          face(`https://${FORGE_HOST.gitlab}/api/v4/projects/trial%2Fapp/merge_requests/1`, {
            headers: { authorization: `Bearer ${tokenOf("gitlab", stale)}` },
          }).then((response) => response.json()),
        );
        yield* bin.restore();
        expect(answered).toMatchObject({ sha: moved });
      }),
    ),
  ));

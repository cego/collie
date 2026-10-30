// The host's merge: the landing attempt written before the forge is asked, its outcome after,
// and an attempt an earlier host left settled on the forge's word.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Result, Schema } from "effect";
import { foundationLayer, Registry, registryLayer } from "../src/engine";
import { agentsLayer } from "../src/agents";
import { land, readLanding, takeOver, writeLanding, type Landing } from "../src/landing";
import { forgeHttpTest } from "../src/forge/http";
import { WorkflowError } from "../src/sdk";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeOnPath,
  serveForges,
  type FakeMr,
  type ForgeModel,
} from "./support/forge";
import { FakeHerdr, Rig } from "./support/recorder";
import * as Layer from "effect/Layer";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MERGED = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";
const URL_OF = {
  gitlab: `https://${PROJECT.gitlab}/-/merge_requests/30`,
  github: `https://${PROJECT.github}/pull/30`,
} as const;

const model = (forge: "gitlab" | "github", over: Partial<FakeMr> = {}): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST[forge]],
  login: "me",
  now: "2026-10-20T12:00:00Z",
  mrs: [
    {
      project: PROJECT[forge],
      iid: "30",
      state: "open",
      head: HEAD,
      targetBranch: "main",
      mergedSha: MERGED,
      ...over,
    },
  ],
});

/** A Run's directory, and a forge whose merge also reads what the Run had recorded by then. */
const landing = Effect.fn("landing.landing")(function* (
  forge: "gitlab" | "github",
  over: Partial<FakeMr> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-landing-" });
  const fake = fakeForge(forge, model(forge, over));
  const seen: Array<Landing | null> = [];
  const services = yield* Effect.context<FileSystem.FileSystem>();
  const http = forgeHttpTest(fake.run, (input, init = {}) =>
    Effect.runPromiseWith(services)(
      Effect.gen(function* () {
        if (init.method === "PUT" && pipe_(input, Str.endsWith("/merge")))
          seen.push(yield* readLanding(runDir));
        return yield* Effect.promise(() => fake.fetch(input, init));
      }),
    ),
  );
  const merge = (head = HEAD, mr: string | null = URL_OF[forge]) =>
    land({ runDir, mr, head, cwd: "/w", run: fake.run }).pipe(Effect.provide(http));
  return { runDir, fake, seen, merge };
});

const attempt = (forge: "gitlab" | "github", over: Partial<Landing> = {}): Landing => ({
  state: "attempt",
  mr: URL_OF[forge],
  head: HEAD,
  at: "2026-10-20T11:00:00Z",
  ...over,
});

for (const forge of ["gitlab", "github"] as const) {
  test(`${forge}: the attempt is written before the forge is asked, and landed on its merge`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { runDir, seen, merge } = yield* landing(forge);
        expect(yield* merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(seen).toEqual([
          { state: "attempt", mr: URL_OF[forge], head: HEAD, at: expect.any(String) },
        ]);
        expect(yield* readLanding(runDir)).toEqual({ ...seen[0]!, state: "landed", sha: MERGED });
        expect(Str.split(yield* fs.readFileString(`${runDir}/log.txt`), "\n")).toEqual([
          `landing: attempting to merge ${URL_OF[forge]} at ${HEAD}`,
          `landing: merged ${URL_OF[forge]} at ${HEAD} as ${MERGED}`,
          "",
        ]);
      }),
    ));

  test(`${forge}: a refusal and a moved head withdraw the attempt`, () =>
    runEffect(
      Effect.gen(function* () {
        const refused = yield* landing(forge, { mergeable: "conflict" });
        const answer = yield* refused.merge();
        expect(answer._tag).toBe("Refused");
        expect(yield* readLanding(refused.runDir)).toMatchObject({
          state: "withdrawn",
          why: answer._tag === "Refused" ? answer.reason : "",
        });

        const moved = yield* landing(forge);
        expect(yield* moved.merge("0ld")).toEqual({ _tag: "HeadMoved", head: HEAD });
        expect(yield* readLanding(moved.runDir)).toMatchObject({
          state: "withdrawn",
          head: "0ld",
          why: `the head moved to ${HEAD}`,
        });
      }),
    ));

  test(`${forge}: a merge request someone else merged first answers merged outside this Run`, () =>
    runEffect(
      Effect.gen(function* () {
        const { runDir, merge } = yield* landing(forge, {
          state: "merged",
          mergedBy: "alice",
          mergedAt: "2026-10-20T11:30:00Z",
        });
        expect(yield* merge()).toEqual({
          _tag: "MergedOutside",
          sha: MERGED,
          by: "alice",
          at: "2026-10-20T11:30:00Z",
        });
        expect(yield* readLanding(runDir)).toMatchObject({
          state: "withdrawn",
          why: "merged outside this Run by alice",
        });
      }),
    ));

  test(`${forge}: a replay of a landed merge answers its recorded merge, and asks the forge nothing`, () =>
    runEffect(
      Effect.gen(function* () {
        const { runDir, seen, merge } = yield* landing(forge);
        yield* merge();
        const landed = yield* readLanding(runDir);
        expect(yield* merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(seen).toHaveLength(1);
        expect(yield* readLanding(runDir)).toEqual(landed);
      }),
    ));

  test(`${forge}: a replay after a restart settles the attempt it left by the rule, merging only an open one`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const mine = yield* landing(forge, {
          state: "merged",
          mergedBy: "me",
          mergedAt: "2026-10-20T11:01:00Z",
        });
        yield* writeLanding(mine.runDir, attempt(forge));
        expect(yield* mine.merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(yield* readLanding(mine.runDir)).toEqual(
          attempt(forge, { state: "landed", sha: MERGED }),
        );
        expect(mine.seen).toEqual([]);

        const theirs = yield* landing(forge, {
          state: "merged",
          mergedBy: "alice",
          mergedAt: "2026-10-20T11:01:00Z",
        });
        yield* writeLanding(theirs.runDir, attempt(forge));
        expect((yield* theirs.merge())._tag).toBe("MergedOutside");
        expect((yield* readLanding(theirs.runDir))?.state).toBe("withdrawn");
        expect(theirs.seen).toEqual([]);

        const open = yield* landing(forge);
        yield* writeLanding(open.runDir, attempt(forge));
        expect(yield* open.merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(open.seen).toEqual([attempt(forge, { at: expect.any(String) })]);
        expect((yield* readLanding(open.runDir))?.state).toBe("landed");
        expect(
          Str.split(yield* fs.readFileString(`${open.runDir}/log.txt`), "\n").slice(1, 3),
        ).toEqual([
          `landing: withdrew the merge of ${URL_OF[forge]} at ${HEAD}: left unanswered by an earlier host`,
          `landing: attempting to merge ${URL_OF[forge]} at ${HEAD}`,
        ]);
      }),
    ));
}

test("a Run that recorded no merge request is refused, and the forge is not asked", () =>
  runEffect(
    Effect.gen(function* () {
      const { runDir, fake, merge } = yield* landing("github");
      const answer = yield* merge(HEAD, null).pipe(Effect.result);
      expect(Result.isFailure(answer)).toBe(true);
      if (Result.isFailure(answer)) {
        expect(Schema.is(WorkflowError)(answer.failure)).toBe(true);
        expect(answer.failure.reason).toBe("this Run has recorded no merge request to merge");
      }
      expect(fake.calls).toEqual([]);
      expect(yield* readLanding(runDir)).toBeNull();
    }),
  ));

/** A Run on this host that landed `forge`'s merge request at MERGED, and how it ended. */
const lander = (
  forge: "gitlab" | "github",
  runId: string,
  ended: { readonly succeeded: boolean; readonly failure: string } | null,
  over: Partial<Landing> = {},
) => ({
  runId,
  landing: attempt(forge, { state: "landed", sha: MERGED, ...over }),
  ended,
});

for (const forge of ["gitlab", "github"] as const) {
  test(`${forge}: a release that failed after its merge is taken over by the Run recovering it`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { runDir, fake } = yield* landing(forge, {
          state: "merged",
          mergedBy: "me",
          mergedAt: "2026-10-20T11:01:00Z",
        });
        const failed = { succeeded: false, failure: "v1.2.0 is not on origin" };
        const runs = [
          lander(
            forge,
            "r-old",
            { succeeded: false, failure: "older" },
            { at: "2026-10-19T00:00:00Z" },
          ),
          lander(forge, "r-failed", failed),
          lander(forge, "r-other", null, { mr: `${URL_OF[forge]}0` }),
        ];
        const took = yield* takeOver({
          runDir,
          mr: URL_OF[forge],
          runs,
          cwd: "/w",
          run: fake.run,
        }).pipe(Effect.provide(fake.layer));
        expect(took).toEqual({
          _tag: "TakenOver",
          from: "r-failed",
          sha: MERGED,
          head: HEAD,
          failure: failed.failure,
        });
        expect(yield* readLanding(runDir)).toMatchObject({
          state: "landed",
          mr: URL_OF[forge],
          head: HEAD,
          sha: MERGED,
          from: "r-failed",
        });
        expect(yield* fs.readFileString(`${runDir}/log.txt`)).toBe(
          `landing: took over the merge of ${URL_OF[forge]} at ${HEAD} as ${MERGED} from r-failed\n`,
        );
        // Asked again, as a replay would: the same answer from what it recorded.
        expect(
          yield* takeOver({ runDir, mr: URL_OF[forge], runs, cwd: "/w", run: fake.run }).pipe(
            Effect.provide(fake.layer),
          ),
        ).toEqual(took);
      }),
    ));

  test(`${forge}: nothing is taken over from a Run that succeeded, still runs, or merged another commit`, () =>
    runEffect(
      Effect.gen(function* () {
        const why = (runs: ReadonlyArray<ReturnType<typeof lander>>, sha = MERGED) =>
          Effect.gen(function* () {
            const { runDir, fake } = yield* landing(forge, { state: "merged", mergedSha: sha });
            const took = yield* takeOver({
              runDir,
              mr: URL_OF[forge],
              runs,
              cwd: "/w",
              run: fake.run,
            }).pipe(Effect.provide(fake.layer));
            expect(yield* readLanding(runDir)).toBeNull();
            return took._tag === "Refused" ? took.why : took._tag;
          });
        expect(yield* why([])).toBe(
          `${URL_OF[forge]} was merged outside a Release Run: no Run on this host landed it`,
        );
        expect(yield* why([lander(forge, "r-done", { succeeded: true, failure: "" })])).toBe(
          `${URL_OF[forge]} was already released by r-done`,
        );
        expect(yield* why([lander(forge, "r-busy", null)])).toBe(
          `${URL_OF[forge]} is still being released by r-busy`,
        );
        expect(
          yield* why([lander(forge, "r-failed", { succeeded: false, failure: "x" })], "c0ffee"),
        ).toBe(`${URL_OF[forge]} was merged at c0ffee, not at the ${MERGED} r-failed landed`);
      }),
    ));
}

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const withMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      registryLayer(rig.stateDir, {
        userDir: rig.userDir,
      }).pipe(
        Layer.provideMerge(
          agentsLayer({
            dir: rig.stateDir,
            env: rig.pluginEnv(),
            herdr: new FakeHerdr(rig.pluginEnv()),
            harness: "claude",
            model: "opus",
            permissions: "auto",
            compactAtTokens: 0,
            help: () => Effect.succeed("--autocompact"),
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir: rig.stateDir,
            userDir: rig.userDir,
          }),
        ),
      ),
    ),
    Effect.scoped,
  );

test(
  "the host merges the merge request a Run recorded, and its landing is a fact of the Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        expect((yield* exec(["git", "init", "--quiet", rig.projectDir])).exitCode).toBe(0);
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", model("github"));
          const forgeApi = yield* serveForges(fake);
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/merges.workflow.ts", import.meta.url).pathname,
            );
            const landed = yield* registry.start({
              generation,
              request: "lands",
              project: rig.projectDir,
              input: { mr: URL_OF.github, head: HEAD },
              handsOver: true,
            });
            expect(yield* registry.result(landed.runId)).toEqual({ _tag: "Merged", sha: MERGED });
            expect((yield* registry.view(landed.runId))?.landing).toMatchObject({
              state: "landed",
              mr: URL_OF.github,
              head: HEAD,
              sha: MERGED,
            });

            const none = yield* registry.start({
              generation,
              request: "none",
              project: rig.projectDir,
              input: { mr: "", head: HEAD },
              handsOver: true,
            });
            const refused = yield* registry.result(none.runId).pipe(Effect.result);
            expect(Result.isFailure(refused)).toBe(true);
            if (Result.isFailure(refused))
              expect(refused.failure.reason).toContain("no merge request");
            expect((yield* registry.view(none.runId))?.landing).toBeNull();
          }).pipe(
            withMachine,
            Effect.provide(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forgeApi })),
            ),
          );
          expect((yield* fake.model()).merges).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);

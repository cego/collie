// A Run waiting on its merge request, through the host's own engine, store and merge watch on
// a fast clock: no agent while it waits, no read of its own, and woken once by what matters.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Clock,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import { TestClock } from "effect/testing";
import type { PlatformServices } from "../src/platform";
import { Rig, FakeHerdr } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges, type FakeMr, type ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { agentsLayer } from "../src/agents";
import {
  Registry,
  STOP,
  foundationLayer,
  registryLayer,
  type Generation,
  type HostServices,
} from "../src/engine";
import { Store } from "../src/store";
import { buildBoard } from "../src/board";
import { mrId, sectionOf } from "../src/board-model";
import { factsOfView } from "../src/runs";
import { mergeWatch } from "../src/side-jobs";
import { QUIET_MS, Woke } from "../src/mr-watch-model";
import type { MrPanels } from "../src/merges";

const ROOT = new URL("../", import.meta.url).pathname;
const PROJECT = "gitlab.cego.dk/mk/collie";
const mrUrl = (iid: string) => `https://${PROJECT}/-/merge_requests/${iid}`;
const WATCHED = mrUrl("7");
const UNWATCHED = mrUrl("8");
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";

let rig: Rig;

beforeEach(() =>
  runLive(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(rig.projectDir, { recursive: true })),
      );
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runLive(rig.close()));

const env = () => rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT });
const dir = () => env().stateDir;

const mr = (iid: string, over: Partial<FakeMr> = {}): FakeMr => ({
  project: PROJECT,
  iid,
  state: "open",
  head: H1,
  author: "ann",
  checks: [{ name: "test", state: "passed" }],
  ...over,
});

const OPEN: ForgeModel = {
  installed: true,
  loggedIn: ["gitlab.cego.dk"],
  login: "mk",
  mrs: [mr("7"), mr("8")],
  ancestry: { [H2]: [H1] },
};
const PUSHED: ForgeModel = { ...OPEN, mrs: [mr("7", { head: H2 }), mr("8")] };

/** glab on PATH and GitLab served, for the whole test, as a host's restart leaves the forge as it was. */
const gitlab = Effect.gen(function* () {
  const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (made) =>
    made.restore(),
  );
  const faked = yield* forgeOnPath(bin, "gitlab", OPEN);
  return { ...faked, api: yield* serveForges(faked) };
});
type Forge = Effect.Success<typeof gitlab>;

const toasts: string[] = [];

const session = <A, E>(
  forge: Forge,
  work: Effect.Effect<A, E, Registry | Store | HostServices | PlatformServices | Scope.Scope>,
) =>
  work.pipe(
    Effect.provide(
      registryLayer(dir(), { placing: { herdr: new FakeHerdr(env()), env: env() } }).pipe(
        Layer.provideMerge(
          agentsLayer({
            dir: dir(),
            env: env(),
            herdr: new FakeHerdr(env()),
            harness: "claude",
            model: "opus",
            permissions: "auto",
            compactAtTokens: 0,
            pollMs: 20,
            collectMs: 60_000,
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir: dir(),
            userDir: rig.userDir,
            toast: (title) => Effect.sync(() => toasts.push(title)),
          }),
        ),
        Layer.provideMerge(
          ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forge.api })),
        ),
      ),
    ),
    Effect.scoped,
  );

const watching = Effect.gen(function* () {
  const registry = yield* Registry;
  const store = yield* Store;
  const hosted = yield* Effect.context<HostServices>();
  const platform = yield* Effect.context<PlatformServices>();
  const panels: MrPanels = new Map();
  const board = Effect.gen(function* () {
    const runs = Arr.map(yield* registry.views(null), (view) => factsOfView(dir(), view));
    const views = yield* buildBoard({
      env: env(),
      runs,
      alive: [],
      offers: () => Effect.succeed([]),
    });
    return { runs, views };
  }).pipe(Effect.provideContext(platform), Effect.orDie);
  yield* Effect.forkScoped(
    mergeWatch({
      env: env(),
      board,
      panels,
      record: () => Effect.void,
      stop: () => Effect.void,
      watches: {
        list: store.watches,
        observe: store.observe,
        wake: (run, name, woke) =>
          registry.wake(run, name, woke).pipe(Effect.provideContext(hosted)),
      },
    }).pipe(Effect.provideContext(platform)),
  );
  return { board };
});

const started = Effect.fn("MrWatch.started")(function* (
  name: string,
  request: string,
  input: Readonly<Record<string, Schema.Json>>,
) {
  const registry = yield* Registry;
  const generation: Generation = (yield* registry.load(`${fixtures}/${name}.workflow.ts`))!;
  const { runId } = yield* registry.start({
    generation,
    request,
    project: rig.projectDir,
    input,
    text: {},
    task: null,
  });
  return runId;
});

/** `read` once `done` holds, looked at each second of the fast clock for up to 20 minutes of it. */
const until = <A, E, R>(read: () => Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.suspend(read).pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("1 second"), times: 1_200 }),
    Effect.filterOrElse(done, () => Effect.die(new Error("it never came"))),
  );

const status = (runId: string) => Registry.pipe(Effect.flatMap((registry) => registry.view(runId)));

const watchOf = (runId: string) =>
  Store.pipe(
    Effect.flatMap((store) => store.watches([mrId(WATCHED)!])),
    Effect.map((rows) => Option.getOrNull(Arr.findFirst(rows, (row) => row.run === runId))),
  );

const reads = (forge: Forge, iid: string) =>
  Arr.filter(forge.requests(), (one) =>
    new RegExp(`/merge_requests/${iid}(?:[/?]|$)`).test(decodeURIComponent(one.url)),
  ).length;

const agentStarts = Effect.map(
  Effect.suspend(() => rig.cmds()),
  Arr.filter((cmd) => cmd === "agent start"),
);

const decodeWoke = (value: Schema.Json | null) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Woke))(value).pipe(Effect.orDie);

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices | Scope.Scope>) =>
  runLive(fastForward(Effect.scoped(Effect.suspend(() => ((toasts.length = 0), effect)))));

test(
  "a Run waits on its merge request with no agent, and resumes once on a new head after the quiet period, reading nothing more",
  () =>
    runEffect(
      Effect.gen(function* () {
        const forge = yield* gitlab;
        yield* session(
          forge,
          Effect.gen(function* () {
            const runId = yield* started("watches-mr", "w1", {
              target: WATCHED,
              head: H1,
              cwd: rig.projectDir,
            });
            yield* started("targeted", "u1", { target: UNWATCHED });
            yield* until(
              () => watchOf(runId),
              (row) => row !== null,
            );
            yield* watching;
            // Rounds of the watch on a head that has not moved wake nothing.
            yield* Effect.sleep("6 minutes");
            expect((yield* status(runId))?.status.status).toBe("suspended");

            yield* forge.set(PUSHED);
            const seen = yield* until(
              () => watchOf(runId),
              (row) => row?.observed?.head === H2,
            );
            const done = yield* until(
              () => status(runId),
              (view) => view?.status.status === "complete",
            );
            const resumedAt = yield* Clock.currentTimeMillis;

            expect(resumedAt - seen!.observed!.since).toBeGreaterThanOrEqual(QUIET_MS);
            const value = done?.status.status === "complete" ? done.status.value : null;
            expect(yield* decodeWoke(value)).toEqual({
              _tag: "Changed",
              change: {
                head: H2,
                previous: H1,
                newHead: true,
                comments: [],
                pipeline: "passed",
                forcePush: false,
              },
            });
            expect(reads(forge, "7")).toBeGreaterThan(0);
            expect(reads(forge, "7")).toBe(reads(forge, "8"));
            expect(yield* agentStarts).toEqual([]);
            expect(
              yield* until(
                () => watchOf(runId),
                (row) => row === null,
              ),
            ).toBeNull();
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a host killed while a Run waits leaves it waiting, and the next host wakes it once, on time from what the first one saw",
  () =>
    runEffect(
      Effect.gen(function* () {
        const forge = yield* gitlab;
        const { runId, since } = yield* session(
          forge,
          Effect.gen(function* () {
            const runId = yield* started("watches-mr", "w1", {
              target: WATCHED,
              head: H1,
              cwd: rig.projectDir,
            });
            yield* until(
              () => watchOf(runId),
              (row) => row !== null,
            );
            yield* forge.set(PUSHED);
            yield* watching;
            const seen = yield* until(
              () => watchOf(runId),
              (row) => row?.observed?.head === H2,
            );
            return { runId, since: seen!.observed!.since };
          }),
        );
        yield* Effect.sleep("3 minutes");
        yield* session(
          forge,
          Effect.gen(function* () {
            expect((yield* status(runId))?.status.status).toBe("suspended");
            expect((yield* watchOf(runId))?.observed?.head).toBe(H2);
            yield* watching;
            const done = yield* until(
              () => status(runId),
              (view) => view?.status.status === "complete",
            );
            const resumedAt = yield* Clock.currentTimeMillis;
            // From the first host's sighting, not from this host's own first read.
            expect(resumedAt - since).toBeLessThan(QUIET_MS + 60_000);
            const value = done?.status.status === "complete" ? done.status.value : null;
            expect((yield* decodeWoke(value))._tag).toBe("Changed");
            expect(yield* agentStarts).toEqual([]);
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a Run waiting on its author for two days reads so on its card, is never overdue or Needs you, and its stop forgets the watch",
  () =>
    runEffect(
      Effect.gen(function* () {
        const forge = yield* gitlab;
        const runId = yield* session(
          forge,
          Effect.gen(function* () {
            const runId = yield* started("watches-mr", "w1", {
              target: WATCHED,
              head: H1,
              cwd: rig.projectDir,
            });
            yield* until(
              () => watchOf(runId),
              (row) => row !== null,
            );
            return runId;
          }),
        );
        yield* TestClock.adjust("48 hours");
        yield* Effect.sleep("1 minute");
        yield* session(
          forge,
          Effect.gen(function* () {
            const { board } = yield* watching;
            yield* Effect.sleep("6 minutes");
            const { views } = yield* board;
            const card = Arr.findFirst(views, (view) =>
              Arr.some(view.runs, (one) => one === runId),
            );
            expect(Option.getOrThrow(card).sentence).toBe(
              "Waiting for the author to change mk/collie!7.",
            );
            expect(sectionOf(Option.getOrThrow(card))).not.toBe("needs-you");
            expect((yield* status(runId))?.status.status).toBe("suspended");
            expect(Arr.filter(toasts, (title) => /needs you|opened/.test(title))).toEqual([]);
            const registry = yield* Registry;
            yield* registry.control({ runId, control: STOP, set: true });
            expect(yield* watchOf(runId)).toBeNull();
          }),
        );
      }),
    ),
  240_000,
);

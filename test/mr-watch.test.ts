import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { Rig } from "./support/recorder";
import { runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { type FakeMr, type ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { decodeWoke, until, watching } from "./support/watching";
import { Registry, STOP } from "../src/engine";
import { sectionOf } from "../src/board-model";
import { QUIET_MS } from "../src/mr-watch-model";

const PROJECT = "gitlab.cego.dk/mk/collie";
const mrUrl = (iid: string) => `https://${PROJECT}/-/merge_requests/${iid}`;
const WATCHED = mrUrl("7");
const UNWATCHED = mrUrl("8");
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";

let rig: Rig;
let host: ReturnType<typeof watching>;

beforeEach(() =>
  runLive(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      host = watching(rig);
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(rig.projectDir, { recursive: true })),
      );
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runLive(rig.close()));

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

const gitlab = Effect.suspend(() => host.gitlab(OPEN));
type Forge = Effect.Success<typeof gitlab>;
const session: ReturnType<typeof watching>["session"] = (forge, work) => host.session(forge, work);
const watchingMerges = Effect.suspend(() => host.mergeWatched);
const started = (name: string, request: string, input: Parameters<typeof host.started>[2]) =>
  Effect.map(
    Effect.suspend(() => host.started(`${fixtures}/${name}.workflow.ts`, request, input)),
    (one) => one.runId,
  );
const status = (runId: string) => Effect.suspend(() => host.status(runId));
const watchOf = (runId: string) => Effect.suspend(() => host.watchOf(runId, WATCHED));
const agentStarts = Effect.suspend(() => host.agentStarts);
const runEffect: ReturnType<typeof watching>["runEffect"] = (effect) => host.runEffect(effect);

const reads = (forge: Forge, iid: string) =>
  Arr.filter(forge.requests(), (one) =>
    new RegExp(`/merge_requests/${iid}(?:[/?]|$)`).test(decodeURIComponent(one.url)),
  ).length;

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
            yield* watchingMerges;
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
            yield* watchingMerges;
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
            yield* watchingMerges;
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
            const { board } = yield* watchingMerges;
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
            expect(Arr.filter(host.toasts, (title) => /needs you|opened/.test(title))).toEqual([]);
            const registry = yield* Registry;
            yield* registry.control({ runId, control: STOP, set: true });
            expect(yield* watchOf(runId)).toBeNull();
          }),
        );
      }),
    ),
  240_000,
);

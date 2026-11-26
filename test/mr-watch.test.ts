import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Deferred, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Rig } from "./support/recorder";
import { runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import type { FakeMr, ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { decodeWoke, until, watching } from "./support/watching";
import { HOLD, Registry, runDir, STOP } from "../src/engine";
import { mrId, sectionOf } from "../src/board-model";
import type { MrPanel } from "../src/board-model";
import { settleWatches } from "../src/mr-watch";
import { readDispositions, recordDisposition } from "../src/disposition";
import { recordAudit } from "../src/audit";
import { Store } from "../src/store";
import { readWatchJournal, recordWatchEvent } from "../src/watch-journal";
import type { WatchEvent } from "../src/watch-journal";
import { epochMs } from "../src/time";
import { QUIET_MS } from "../src/mr-watch-model";

const PROJECT = "gitlab.cego.dk/mk/collie";
const mrUrl = (iid: string) => `https://${PROJECT}/-/merge_requests/${iid}`;
const WATCHED = mrUrl("7");
const UNWATCHED = mrUrl("8");
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const H3 = "3333333333333333333333333333333333333333";

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

const mr: (iid: string, over?: Partial<FakeMr>) => FakeMr = (iid, over = {}) => ({
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
  ancestry: { [H2]: [H1], [H3]: [H2] },
};
const PUSHED: ForgeModel = { ...OPEN, mrs: [mr("7", { head: H2 }), mr("8")] };
const PUSHED_AGAIN: ForgeModel = { ...OPEN, mrs: [mr("7", { head: H3 }), mr("8")] };

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

const tagged = <T extends WatchEvent["_tag"]>(events: ReadonlyArray<WatchEvent>, tag: T) =>
  Arr.filter(events, (event): event is Extract<WatchEvent, { _tag: T }> => event._tag === tag);

const pollsIn = (events: ReadonlyArray<WatchEvent>) =>
  Arr.filter(
    events,
    (event): event is Extract<WatchEvent, { _tag: "poll" }> =>
      event._tag === "poll" && event.mr === mrId(WATCHED),
  );

const readLogLines = (runId: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.map(
      fs.readFileString(`${host.dir()}/runs/${runId}/log.txt`).pipe(Effect.orElseSucceed(() => "")),
      (text) => Str.split(text, "\n"),
    ),
  );

const roundsOf = (runId: string) =>
  Effect.map(readLogLines(runId), (lines) =>
    Arr.filter(lines, (line) => /round-\d+: \S+ -> \S+/.test(line)),
  );

test("a Run waits on its merge request with no agent, and resumes once on a new head after the quiet period, reading nothing more", () =>
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
  ));

test("a host killed while a Run waits leaves it waiting, and the next host wakes it once, on time from what the first one saw", () =>
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
          // WARNING: measured from the first host's sighting, not this host's own first read.
          expect(resumedAt - since).toBeLessThan(QUIET_MS + 60_000);
          const value = done?.status.status === "complete" ? done.status.value : null;
          expect((yield* decodeWoke(value))._tag).toBe("Changed");
          expect(yield* agentStarts).toEqual([]);
        }),
      );
    }),
  ));

test("a Run waiting on its author for two days reads so on its card, is never overdue or Needs you, and its stop ends its demand", () =>
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
          const card = Arr.findFirst(views, (view) => Arr.some(view.runs, (one) => one === runId));
          expect(Option.getOrThrow(card).sentence).toBe(
            "Waiting for the author to change mk/collie!7.",
          );
          expect(sectionOf(Option.getOrThrow(card))).not.toBe("needs-you");
          expect((yield* status(runId))?.status.status).toBe("suspended");
          expect(Arr.filter(host.toasts, (title) => /needs you|opened/.test(title))).toEqual([]);
          const registry = yield* Registry;
          yield* registry.control({ runId, control: STOP, set: true });
          const stopped = yield* watchOf(runId);
          expect(stopped).not.toBeNull();
          yield* forge.set(PUSHED);
          yield* Effect.sleep("10 minutes");
          const after = yield* watchOf(runId);
          expect(after?.observed ?? null).toEqual(stopped?.observed ?? null);
          expect(after?.woke ?? null).toBeNull();
        }),
      );
    }),
  ));

test("a Review stopped, abandoned and resumed keeps its Watch, waking once on each of two pushes by the background poll alone", () =>
  runEffect(
    Effect.gen(function* () {
      const forge = yield* gitlab;
      const runId = yield* session(
        forge,
        Effect.gen(function* () {
          const registry = yield* Registry;
          const runId = yield* started("watches-mr", "w1", {
            target: WATCHED,
            head: H1,
            cwd: rig.projectDir,
            rounds: 2,
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          yield* registry.control({ runId, control: STOP, set: true });
          yield* recordDisposition(runDir(host.dir(), runId), {
            at: "2026-11-26T10:22:28Z",
            by: "cli:recovery",
            kind: "abandoned",
            ref: "",
            note: null,
          });
          yield* registry.resume(runId);
          yield* recordAudit(runDir(host.dir(), runId), {
            operation: "resume",
            request: "resume-1",
            origin: "cli",
            result: Schema.Struct({}),
            value: {},
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          return runId;
        }),
      );
      yield* session(
        forge,
        Effect.gen(function* () {
          const { board } = yield* watchingMerges;
          yield* forge.set(PUSHED);
          const seen = yield* until(
            () => watchOf(runId),
            (row) => row?.observed?.head === H2,
          );
          yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-2",
          );
          const wokeAt = yield* Clock.currentTimeMillis;
          expect(wokeAt - seen!.observed!.since).toBeGreaterThanOrEqual(QUIET_MS);
          expect(wokeAt - seen!.observed!.since).toBeLessThan(QUIET_MS + 2 * 60_000);
          yield* Effect.sleep("20 minutes");
          const waiting = yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-2",
          );
          expect(waiting!.observed?.head).toBe(H2);
          expect(waiting!.woke ?? null).toBeNull();
          expect((yield* status(runId))?.status.status).toBe("suspended");

          const { views } = yield* board;
          const card = Option.getOrThrow(
            Arr.findFirst(views, (view) => Arr.some(view.runs, (one) => one === runId)),
          );
          expect(card.sentence).toBe("Waiting for the author to change mk/collie!7.");
          const entry = Arr.findFirst(card.mrs ?? [], (one) => one.id === mrId(WATCHED));
          expect(Option.getOrThrow(entry).settled).toBeNull();
          expect(
            Arr.map(
              yield* readDispositions(runDir(host.dir(), runId)).pipe(
                Effect.orElseSucceed(() => []),
              ),
              (line) => line.kind,
            ),
          ).toContain("abandoned");

          yield* forge.set(PUSHED_AGAIN);
          yield* until(
            () => status(runId),
            (view) => view?.status.status === "complete",
          );
          const rounds = yield* roundsOf(runId);
          expect([
            ...new Set(Arr.map(rounds, (line) => Str.replace(/^.*?round-\d+: /, "")(line))),
          ]).toEqual([`${H1} -> ${H2}`, `${H2} -> ${H3}`]);
          expect(yield* agentStarts).toEqual([]);
          expect(reads(forge, "7")).toBeGreaterThan(0);
        }),
      );
    }),
  ));

test("a host restarting inside the quiet window wakes the resumed Run at the deadline the first host set, with no detail reader", () =>
  runEffect(
    Effect.gen(function* () {
      const forge = yield* gitlab;
      const { runId, since } = yield* session(
        forge,
        Effect.gen(function* () {
          const registry = yield* Registry;
          const runId = yield* started("watches-mr", "w1", {
            target: WATCHED,
            head: H1,
            cwd: rig.projectDir,
            rounds: 2,
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          yield* registry.control({ runId, control: STOP, set: true });
          yield* recordDisposition(runDir(host.dir(), runId), {
            at: "2026-11-26T10:22:28Z",
            by: "cli:recovery",
            kind: "abandoned",
            ref: "",
            note: null,
          });
          yield* registry.resume(runId);
          yield* recordAudit(runDir(host.dir(), runId), {
            operation: "resume",
            request: "resume-1",
            origin: "cli",
            result: Schema.Struct({}),
            value: {},
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
          yield* watchingMerges;
          expect((yield* status(runId))?.status.status).toBe("suspended");
          expect((yield* watchOf(runId))?.observed?.head).toBe(H2);
          yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-2",
          );
          const wokeAt = yield* Clock.currentTimeMillis;
          expect(wokeAt - since).toBeLessThan(QUIET_MS + 60_000);
          expect(yield* agentStarts).toEqual([]);
        }),
      );
    }),
  ));

test("a wake a dead host persisted is delivered once by the next host, with no panel and no second round", () =>
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
          const store = yield* Store;
          yield* store.wake(runId, "round-1", {
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
          return runId;
        }),
      );
      yield* forge.set(PUSHED_AGAIN);
      yield* session(
        forge,
        Effect.gen(function* () {
          yield* watchingMerges;
          const done = yield* until(
            () => status(runId),
            (view) => view?.status.status === "complete",
          );
          expect(
            yield* decodeWoke(done?.status.status === "complete" ? done.status.value : null),
          ).toEqual({
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
          expect(yield* watchOf(runId)).toBeNull();
          expect(yield* agentStarts).toEqual([]);
        }),
      );
    }),
  ));

test("a Watch of a merge request recorded in production is still read by the restarted host, and ends once", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${host.dir()}/board`, { recursive: true });
      yield* fs.writeFileString(
        `${host.dir()}/board/mr-states.json`,
        JSON.stringify({
          [mrId(WATCHED)!]: {
            state: "in-prod",
            read: "2026-01-01T00:00:00Z",
            asked: "2026-01-01T00:00:00Z",
          },
        }),
      );
      const forge = yield* host.gitlab({
        ...OPEN,
        mrs: [mr("7", { state: "merged" }), mr("8")],
      });
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
      yield* session(
        forge,
        Effect.gen(function* () {
          yield* watchingMerges;
          const done = yield* until(
            () => status(runId),
            (view) => view?.status.status === "complete" || view?.status.status === "failed",
          );
          expect(
            yield* decodeWoke(done?.status.status === "complete" ? done.status.value : null),
          ).toEqual({ _tag: "Ended", state: "merged" });
          expect(yield* watchOf(runId)).toBeNull();
        }),
      );
    }),
  ));

for (const [control, said] of [
  [STOP, "stopped"],
  [HOLD, "held"],
] as const) {
  test(`a Watch's answer read while the Run is ${said} banks no head and wakes nothing`, () =>
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
        yield* session(
          forge,
          Effect.gen(function* () {
            const registry = yield* Registry;
            yield* watchingMerges;
            yield* Effect.sleep("6 minutes");
            expect((yield* watchOf(runId))?.observed?.head).toBe(H1);
            const gate = yield* Deferred.make<void>();
            const reached = yield* Deferred.make<void>();
            let blocked = false;
            forge.before((url) => {
              if (blocked || !/merge_requests\/7$/.test(decodeURIComponent(url))) {
                return Promise.resolve();
              }
              blocked = true;
              Effect.runSync(Deferred.succeed(reached, undefined));
              return Effect.runPromise(Deferred.await(gate));
            });
            yield* forge.set(PUSHED);
            yield* Deferred.await(reached);
            yield* registry.control({ runId, control, set: true });
            yield* Deferred.succeed(gate, undefined);
            yield* Effect.sleep("2 minutes");
            const row = yield* watchOf(runId);
            expect(row?.observed?.head).toBe(H1);
            expect(row?.woke ?? null).toBeNull();
            expect((yield* status(runId))?.parked ?? null).toBeNull();
            expect((yield* status(runId))?.status.status).toBe("suspended");
          }),
        );
      }),
    ));
}

test("a held Run's Watch asks for nothing until the hold is released, then takes the head it missed", () =>
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
      yield* session(
        forge,
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* watchingMerges;
          yield* Effect.sleep("6 minutes");
          const before = yield* watchOf(runId);
          expect(before?.observed?.head).toBe(H1);
          yield* registry.control({ runId, control: HOLD, set: true });
          yield* forge.set(PUSHED);
          yield* Effect.sleep("20 minutes");
          const held = yield* watchOf(runId);
          expect(held?.observed?.head).toBe(H1);
          expect(held?.woke ?? null).toBeNull();
          expect((yield* status(runId))?.status.status).toBe("suspended");

          yield* registry.control({ runId, control: HOLD, set: false });
          yield* until(
            () => watchOf(runId),
            (row) => row?.observed?.head === H2,
          );
          yield* Effect.sleep("6 minutes");
          yield* until(
            () => status(runId),
            (view) => view?.status.status === "complete",
          );
          expect(yield* agentStarts).toEqual([]);
        }),
      );
    }),
  ));

test("a wake the Run's control refuses is not recorded as a review start", () =>
  runEffect(
    Effect.gen(function* () {
      const forge = yield* gitlab;
      yield* session(
        forge,
        Effect.gen(function* () {
          const registry = yield* Registry;
          const store = yield* Store;
          const runId = yield* started("watches-mr", "w1", {
            target: WATCHED,
            head: H1,
            cwd: rig.projectDir,
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          yield* registry.control({ runId, control: STOP, set: true });
          const now = yield* Clock.currentTimeMillis;
          yield* store.observe(runId, "round-1", {
            head: H2,
            since: now - QUIET_MS - 1_000,
            running: null,
          });
          const panel: MrPanel = {
            _tag: "Details",
            iid: "7",
            project: PROJECT,
            title: "A review",
            state: "open",
            author: "ann",
            assignees: [],
            sourceBranch: "follow",
            targetBranch: "master",
            pipeline: "passed",
            checks: { state: "passed" },
            approvals: "",
            unresolved: false,
            notes: 0,
            headSha: H2,
            head: H2,
            mergedSha: "",
            updatedAt: now,
            url: WATCHED,
          };
          yield* settleWatches({
            panels: new Map([[mrId(WATCHED)!, { at: now, panel }]]),
            now,
            rows: yield* store.outstanding,
            watches: {
              outstanding: store.outstanding,
              observe: store.observe,
              unavailable: () => Effect.void,
              wake: (run, name, woke) => registry.wake(run, name, woke),
            },
            event: recordWatchEvent(host.dir()),
          });
          const journal = yield* readWatchJournal(host.dir());
          expect(Arr.filter(tagged(journal, "woke"), (one) => one.run === runId)).toEqual([]);
          expect(yield* watchOf(runId)).not.toBeNull();
        }),
      );
    }),
  ));

test("a Watch's answer arriving after the Run is stopped wakes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const forge = yield* gitlab;
      const runId = yield* session(
        forge,
        Effect.gen(function* () {
          const registry = yield* Registry;
          const runId = yield* started("watches-mr", "w1", {
            target: WATCHED,
            head: H1,
            cwd: rig.projectDir,
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          yield* registry.control({ runId, control: STOP, set: true });
          yield* registry.wake(runId, "round-1", {
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
          yield* Effect.sleep("1 minute");
          expect((yield* watchOf(runId))?.woke ?? null).toBeNull();
          expect((yield* status(runId))?.status.status).toBe("suspended");
          expect(yield* roundsOf(runId)).toEqual([]);
          return runId;
        }),
      );
      expect(runId).toStartWith("run-");
    }),
  ));

for (const state of ["closed", "merged"] as const) {
  test(`a Watch whose merge request is ${state} ends once, and settles its Task no further`, () =>
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
        yield* session(
          forge,
          Effect.gen(function* () {
            yield* watchingMerges;
            yield* Effect.sleep("6 minutes");
            yield* forge.set({ ...OPEN, mrs: [mr("7", { state }), mr("8")] });
            const done = yield* until(
              () => status(runId),
              (view) => view?.status.status === "complete" || view?.status.status === "failed",
            );
            expect(
              yield* decodeWoke(done?.status.status === "complete" ? done.status.value : null),
            ).toEqual({ _tag: "Ended", state });
            expect(yield* watchOf(runId)).toBeNull();
            expect(
              Arr.map(
                yield* readDispositions(runDir(host.dir(), runId)).pipe(
                  Effect.orElseSucceed(() => []),
                ),
                (line) => line.kind,
              ),
            ).toEqual(state === "merged" ? ["merged"] : []);
            expect((yield* status(runId))?.controls ?? []).toEqual([]);
          }),
        );
      }),
    ));
}

test("the !604 replay reads detection, eligibility, each start and a failed read back out of what the host recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const forge = yield* gitlab;
      const H4 = "4444444444444444444444444444444444444444";
      const H5 = "5555555555555555555555555555555555555555";
      const H6 = "6666666666666666666666666666666666666666";
      const runId = yield* session(
        forge,
        Effect.gen(function* () {
          const runId = yield* started("watches-mr", "w1", {
            target: WATCHED,
            head: H1,
            cwd: rig.projectDir,
            rounds: 5,
            notes: [1, 3],
            review: 2,
          });
          yield* until(
            () => watchOf(runId),
            (row) => row !== null,
          );
          yield* watchingMerges;

          yield* Effect.sleep("6 minutes");
          const readOut = pollsIn(yield* readWatchJournal(host.dir()));
          expect(readOut.length).toBeGreaterThan(0);
          expect(Arr.reduce(readOut, 0, (total, event) => total + event.attempts)).toBe(
            Arr.filter(forge.requests(), (one) =>
              /\/merge_requests\/7(?:[/?]|$)/.test(decodeURIComponent(one.url)),
            ).length,
          );

          yield* forge.set(PUSHED);
          yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-2",
          );
          yield* forge.set(PUSHED_AGAIN);
          yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-3",
          );
          yield* forge.set({ ...OPEN, mrs: [mr("7", { head: H4 }), mr("8")] });
          yield* until(
            () => readLogLines(runId),
            (lines) => Arr.some(lines, (line) => Str.includes("round-3: reviewing")(line)),
          );
          yield* forge.set({ ...OPEN, mrs: [mr("7", { head: H5 }), mr("8")] });
          yield* until(
            () => watchOf(runId),
            (row) => row?.name === "round-5" && row.observed?.head === H5,
          );
          forge.after((url, _init, response) =>
            Str.endsWith("merge_requests/7")(decodeURIComponent(url))
              ? Promise.resolve(Response.json({ message: "gone" }, { status: 404 }))
              : Promise.resolve(response),
          );
          yield* forge.set({ ...OPEN, mrs: [mr("7", { head: H6 }), mr("8")] });
          yield* Effect.sleep("6 minutes");
          expect((yield* status(runId))?.status.status).toBe("suspended");
          expect((yield* watchOf(runId))?.observed?.head).toBe(H5);
          return runId;
        }),
      );

      const journal = yield* readWatchJournal(host.dir());
      const polls = pollsIn(journal);
      const seen = tagged(journal, "observed");
      const starts = tagged(journal, "woke");

      const firstSeen = (head: string) =>
        Math.min(
          ...Arr.map(
            Arr.filter(seen, (event) => event.head === head),
            (event) => epochMs(event.at),
          ),
        );
      expect(firstSeen(H2)).toBeGreaterThan(0);
      for (const start of starts) {
        const detected = Arr.findLast(
          seen,
          (event) => event.head === start.head && epochMs(event.at) <= epochMs(start.at),
        );
        expect(Option.isSome(detected)).toBe(true);
        expect(epochMs(start.at) - Option.getOrThrow(detected).since).toBeGreaterThanOrEqual(
          QUIET_MS,
        );
      }
      expect(Arr.map(starts, (event) => event.name)).toEqual([
        "round-1",
        "round-2",
        "round-3",
        "round-4",
      ]);
      expect(Arr.map(starts, (event) => event.head)).toEqual([H2, H3, H4, H5]);

      const published = tagged(journal, "published");
      expect(Arr.map(published, (event) => event.head)).toEqual([H2]);
      const discarded = tagged(journal, "discarded");
      expect(Arr.map(discarded, (event) => [event.head, event.moved])).toEqual([[H4, H5]]);
      const completed = tagged(journal, "completed");
      expect(Arr.map(completed, (event) => event.name)).toEqual([
        "round-2",
        "round-3",
        "round-4",
        "round-5",
      ]);
      const noFeedback = Arr.findFirst(completed, (event) => event.name === "round-3");
      const wokeSecond = Arr.findFirst(starts, (event) => event.name === "round-2");
      expect(
        Arr.some(
          [...published, ...discarded],
          (event) =>
            epochMs(event.at) > epochMs(Option.getOrThrow(wokeSecond).at) &&
            epochMs(event.at) < epochMs(Option.getOrThrow(noFeedback).at),
        ),
      ).toBe(false);

      const failed = Arr.filter(polls, (event) => event.result === "failed");
      expect(failed.length).toBeGreaterThan(0);
      for (const poll of failed) {
        expect(poll.attempts).toBeGreaterThan(0);
        expect(poll.head).toBeNull();
      }
      expect(Arr.filter(seen, (event) => event.head === H6)).toEqual([]);
      for (const poll of polls) {
        expect(poll.attempts).toBeGreaterThan(0);
      }
    }),
  ));

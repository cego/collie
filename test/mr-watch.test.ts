import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Rig } from "./support/recorder";
import { runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { type FakeMr, type ForgeModel } from "./support/forge";
import { fixtures } from "./support/host";
import { decodeWoke, until, watching } from "./support/watching";
import { HOLD, Registry, runDir, STOP } from "../src/engine";
import { sectionOf, mrId } from "../src/board-model";
import { QUIET_MS } from "../src/mr-watch-model";
import { readDispositions, recordDisposition } from "../src/disposition";
import { recordAudit } from "../src/audit";
import { Store } from "../src/store";
import { epochMs } from "../src/time";

const PROJECT = "gitlab.cego.dk/mk/collie";
const mrUrl = (iid: string) => `https://${PROJECT}/-/merge_requests/${iid}`;
const WATCHED = mrUrl("7");
const UNWATCHED = mrUrl("8");
const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const H3 = "3333333333333333333333333333333333333333";
const KEY = `${PROJECT}!7`;

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
  ancestry: { [H2]: [H1], [H3]: [H2] },
};
const PUSHED: ForgeModel = { ...OPEN, mrs: [mr("7", { head: H2 }), mr("8")] };
const PUSHED_AGAIN: ForgeModel = { ...OPEN, mrs: [mr("7", { head: H3 }), mr("8")] };

/** The heads each watch round woke on, as the Run recorded them. */
const roundsOf = (runId: string) =>
  Effect.map(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs
          .readFileString(`${host.dir()}/runs/${runId}/log.txt`)
          .pipe(Effect.orElseSucceed(() => "")),
      ),
    ),
    (text) => Arr.filter(text.split("\n"), (line) => line.includes("round-")),
  );

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
  "a Run waiting on its author for two days reads so on its card, is never overdue or Needs you, and its stop ends its demand",
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
            // The registration stays for a Resume to take up; a stopped Run asks for nothing.
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
    ),
  240_000,
);

test(
  "a Review stopped, abandoned and resumed keeps its Watch, waking once on each of two pushes by the background poll alone",
  () =>
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
            const again = yield* until(
              () => watchOf(runId),
              (row) => row?.name === "round-2",
            );
            const wokeAt = yield* Clock.currentTimeMillis;
            expect(again!.run).toBe(runId);
            expect(wokeAt - seen!.observed!.since).toBeGreaterThanOrEqual(QUIET_MS);
            expect(wokeAt - seen!.observed!.since).toBeLessThan(QUIET_MS + 2 * 60_000);
            // Nothing else wakes it: the re-armed round waits on the head it already has.
            yield* Effect.sleep("20 minutes");
            const waiting = yield* until(
              () => watchOf(runId),
              (row) => row?.name === "round-2",
            );
            expect(waiting!.observed?.head).toBe(H2);
            expect(waiting!.woke ?? null).toBeNull();
            expect((yield* status(runId))?.status.status).toBe("suspended");

            // While the resumed Review waits, its merge request is not settled by the old
            // abandonment, which its history keeps.
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
            // A replay records its round again; the heads it woke on are the two pushes.
            expect([...new Set(rounds.map((line) => line.replace(/^.*?round-\d+: /, "")))]).toEqual([
              `${H1} -> ${H2}`,
              `${H2} -> ${H3}`,
            ]);
            expect(yield* agentStarts).toEqual([]);
            expect(reads(forge, "7")).toBeGreaterThan(0);
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a host restarting inside the quiet window wakes the resumed Run at the deadline the first host set, with no detail reader",
  () =>
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
        // The host dies before the deadline, its panels with it.
        yield* Effect.sleep("3 minutes");
        yield* session(
          forge,
          Effect.gen(function* () {
            yield* watchingMerges;
            expect((yield* status(runId))?.status.status).toBe("suspended");
            expect((yield* watchOf(runId))?.observed?.head).toBe(H2);
            const again = yield* until(
              () => watchOf(runId),
              (row) => row?.name === "round-2",
            );
            const wokeAt = yield* Clock.currentTimeMillis;
            expect(wokeAt - since).toBeLessThan(QUIET_MS + 60_000);
            expect(yield* agentStarts).toEqual([]);
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a wake a dead host persisted is delivered once by the next host, with no panel and no second round",
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
            // What a host that was killed between judging a head and answering the wait
            // leaves behind: the read's verdict, kept for the next host.
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
        // A third head arrived while no host was running: the wake that reaches the wait is
        // the one the dead host judged, not a new one read now.
        yield* forge.set(PUSHED_AGAIN);
        yield* session(
          forge,
          Effect.gen(function* () {
            yield* watchingMerges;
            const done = yield* until(
              () => status(runId),
              (view) => view?.status.status === "complete",
            );
            expect(done?.status.status === "complete" ? done.status.value : null).toBe(
              JSON.stringify({
                _tag: "Changed",
                change: {
                  head: H2,
                  previous: H1,
                  newHead: true,
                  comments: [],
                  pipeline: "passed",
                  forcePush: false,
                },
              }),
            );
            expect(yield* watchOf(runId)).toBeNull();
            expect(yield* agentStarts).toEqual([]);
          }),
        );
      }),
    ),
  240_000,
);

test(
  "a held Run's Watch asks for nothing until the hold is released, then takes the head it missed",
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
    ),
  240_000,
);

test(
  "a Watch's answer arriving after the Run is stopped wakes nothing",
  () =>
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
            // The read this Run's watch was already being judged on answers now.
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
    ),
  240_000,
);

for (const state of ["closed", "merged"] as const)
  test(
    `a Watch whose merge request is ${state} ends once, and settles its Task no further`,
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
              expect(done?.status.status === "complete" ? done.status.value : null).toBe(
                JSON.stringify({ _tag: "Ended", state }),
              );
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
      ),
    240_000,
  );

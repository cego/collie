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
import { readWatchJournal, type WatchEvent } from "../src/watch-journal";
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

/** The journal's lines of one kind, which a plain filter does not narrow. */
const tagged = <T extends WatchEvent["_tag"]>(events: ReadonlyArray<WatchEvent>, tag: T) =>
  Arr.filter(events, (event): event is Extract<WatchEvent, { _tag: T }> => event._tag === tag);

const pollsIn = (events: ReadonlyArray<WatchEvent>) =>
  Arr.filter(
    events,
    (event): event is Extract<WatchEvent, { _tag: "poll" }> =>
      event._tag === "poll" && event.mr === mrId(WATCHED),
  );

/** Every line the Run recorded, in the order it wrote them. */
const readLogLines = (runId: string) =>
  Effect.map(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs
          .readFileString(`${host.dir()}/runs/${runId}/log.txt`)
          .pipe(Effect.orElseSucceed(() => "")),
      ),
    ),
    (text) => text.split("\n"),
  );

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
            expect([...new Set(rounds.map((line) => line.replace(/^.*?round-\d+: /, "")))]).toEqual(
              [`${H1} -> ${H2}`, `${H2} -> ${H3}`],
            );
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

test(
  "the !604 replay reads detection, eligibility, each start and a failed read back out of what the host recorded",
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
              rounds: 3,
              publish: 1,
            });
            yield* until(
              () => watchOf(runId),
              (row) => row !== null,
            );
            const { board } = yield* watchingMerges;

            // Nothing has been pushed yet, so the merge watch is the only reader: what the
            // transport saw is exactly what the polls say they sent.
            yield* Effect.sleep("6 minutes");
            const readOut = pollsIn(yield* readWatchJournal(host.dir()));
            expect(readOut.length).toBeGreaterThan(0);
            expect(readOut.reduce((total, event) => total + event.attempts, 0)).toBe(
              Arr.filter(forge.requests(), (one) =>
                /\/merge_requests\/7(?:[/?]|$)/.test(decodeURIComponent(one.url)),
              ).length,
            );

            // A push the background poll finds, and a round that publishes what it found.
            yield* forge.set(PUSHED);
            yield* until(
              () => watchOf(runId),
              (row) => row?.name === "round-2",
            );
            // A second push: the round it starts publishes nothing, and is superseded.
            yield* forge.set(PUSHED_AGAIN);
            yield* until(
              () => watchOf(runId),
              (row) => row?.name === "round-3",
            );
            // A read the forge refuses is recorded as such, and the head it could not read
            // is not one any start was made on.
            let refused = false;
            forge.after((url, _init, response) => {
              if (refused || !/merge_requests\/7$/.test(decodeURIComponent(url)))
                return Promise.resolve(response);
              refused = true;
              return Promise.resolve(Response.json({ message: "gone" }, { status: 404 }));
            });
            const H4 = "4444444444444444444444444444444444444444";
            yield* forge.set({ ...OPEN, mrs: [mr("7", { head: H4 }), mr("8")] });
            yield* Effect.sleep("6 minutes");
            yield* until(
              () => status(runId),
              (view) => view?.status.status === "complete",
            );
            expect(yield* board).toBeDefined();
            return runId;
          }),
        );

        const journal = yield* readWatchJournal(host.dir());
        const polls = pollsIn(journal);
        const seen = tagged(journal, "observed");
        const starts = tagged(journal, "woke");
        const H4 = "4444444444444444444444444444444444444444";

        // Detection: the head it first read, and since when it has stood.
        const firstSeen = (head: string) =>
          Math.min(
            ...Arr.map(
              Arr.filter(seen, (event) => event.head === head),
              (event) => epochMs(event.at),
            ),
          );
        expect(firstSeen(H2)).toBeGreaterThan(0);
        // Eligibility and start: each start follows the quiet window from its detection.
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
        expect(Arr.map(starts, (event) => event.head)).toEqual([H2, H3, H4]);

        // A failed read is a failure, with the attempts it took, and it advances nothing.
        const failed = Arr.filter(polls, (event) => event.result === "failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]!.attempts).toBeGreaterThan(0);
        expect(failed[0]!.head).toBeNull();
        expect(Arr.filter(seen, (event) => event.head === H4)).toHaveLength(1);
        // Every start is on a head a read verified.
        for (const start of starts)
          expect(Arr.some(seen, (event) => event.head === start.head)).toBe(true);

        // The watch's reads are reconciled above; each of these lines names the requests it
        // sent, so none of them is a request the transport cannot account for.
        expect(polls.length).toBeGreaterThan(0);
        for (const poll of polls) expect(poll.attempts).toBeGreaterThan(0);

        // Each round is told from the times it has. The round started on H2 published; the
        // two after it posted nothing, the first superseded by a newer head and the last
        // with no newer head and no note at all.
        const posted = Arr.filter(yield* readLogLines(runId), (line) => line.includes("posted:"));
        // A replayed round records its line again; one round published, and no other did.
        expect([...new Set(posted.map((line) => /round-(\d+)/.exec(line)?.[1]))]).toEqual(["1"]);
        expect(firstSeen(H3)).toBeGreaterThan(epochMs(starts[0]!.at));
        expect(firstSeen(H3)).toBeLessThanOrEqual(epochMs(starts[1]!.at));
        expect(firstSeen(H4)).toBeGreaterThan(epochMs(starts[1]!.at));
        expect(firstSeen(H4)).toBeLessThanOrEqual(epochMs(starts[2]!.at));
      }),
    ),
  300_000,
);

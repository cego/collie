// Desktop counts a write done only on its host's reply: it waits 30 s an attempt, sends the
// same request again up to 3 times, and keeps a line per attempt in `actions.log`.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { act, actOn, type Door } from "../desktop/src/bun/machine";
import { actionsLog, type Attempted } from "../desktop/src/bun/sent";
import { ActionFailed, type DesktopAction } from "../desktop/src/shared/flock";
import { HostRefused, type ActionResult } from "../src/board-model";
import { fastForward } from "./support/effect";

const machine = { profile: "vm", name: "vm-mk" };
const answer: DesktopAction = {
  _tag: "Answer",
  runId: "r-1",
  decision: "next-1",
  value: "the-answer-value",
};
const UNCONFIRMED =
  "vm-mk did not confirm the answer to r-1 within 30 s, 3 times. It may still land; Try again sends the same request, which vm-mk takes at most once.";

const logged = () => {
  const lines: Attempted[] = [];
  return { lines, log: (line: Attempted) => Effect.sync(() => void lines.push(line)) };
};

/** A door whose `answer` replies with each of `replies` in turn, and never after them. */
const answering = (replies: ReadonlyArray<ReturnType<Door["answer"]>>) => {
  const requests: string[] = [];
  const fake: Partial<Door> = {
    // Sent each time it is run, as the client's call is.
    // SAFETY: an Answer never asks to discard the reply.
    answer: ((payload: Parameters<Door["answer"]>[0]) =>
      Effect.suspend(() => {
        requests.push(payload.request);
        return replies[requests.length - 1] ?? Effect.never;
      })) as Door["answer"],
  };
  // SAFETY: an Answer calls only `answer`.
  return { requests, reached: { machine, desktop: fake as Door } };
};

const accepted = (fresh: boolean) =>
  Effect.succeed({ runId: "r-1", decision: "next-1", value: "the-answer-value", fresh });

test("an answer whose first send is not confirmed is sent again under its request, and reads back as a repeat", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { lines, log } = logged();
      const door = answering([Effect.never, accepted(false)]);
      const said = yield* fastForward(act(door.reached, "ask-1", answer, log), 1_000);
      expect(said).toBe("Answered r-1");
      expect(door.requests).toEqual(["ask-1", "ask-1"]);
      expect(Arr.map(lines, ({ attempt, ended }) => [attempt, ended])).toEqual([
        [1, "timed-out"],
        [2, "repeat"],
      ]);
    }),
  ));

test("a host that never confirms is tried 3 times, and the failure says so under its request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { lines, log } = logged();
      const door = answering([]);
      const failed = yield* fastForward(
        act(door.reached, "ask-2", answer, log).pipe(Effect.flip),
        1_000,
      );
      expect(failed).toEqual(new ActionFailed({ request: "ask-2", reason: UNCONFIRMED }));
      expect(door.requests).toEqual(["ask-2", "ask-2", "ask-2"]);
      expect(Arr.map(lines, ({ ended }) => ended)).toEqual(["timed-out", "timed-out", "timed-out"]);
    }),
  ));

test("a refusal is said at once, tried once, and logged with the host's reason", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { lines, log } = logged();
      const door = answering([Effect.fail(new HostRefused({ reason: "already answered" }))]);
      const failed = yield* act(door.reached, "ask-3", answer, log).pipe(Effect.flip);
      expect(failed).toEqual(new ActionFailed({ request: "ask-3", reason: "already answered" }));
      expect(door.requests).toEqual(["ask-3"]);
      expect(lines).toEqual([
        {
          door: "board",
          machine: "vm-mk",
          request: "ask-3",
          kind: "Answer",
          about: "r-1",
          attempt: 1,
          ended: "refused",
          reason: "already answered",
        },
      ]);
    }),
  ));

test("a card action Desktop does not send says why, and is logged as not sent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { lines, log } = logged();
      const door = answering([accepted(true)]);
      const doors = new Map([["i-vm", door.reached]]);
      const saved = yield* actOn(
        doors,
        "i-vm",
        "ask-4",
        answer,
        log,
        "its board is saved, as of 08:46",
      ).pipe(Effect.flip);
      expect(saved).toEqual(
        new ActionFailed({
          request: "ask-4",
          reason: "Not sent to vm-mk: its board is saved, as of 08:46.",
        }),
      );
      const gone = yield* actOn(doors, "i-other", "ask-5", answer, log).pipe(Effect.flip);
      expect(gone.reason).toStartWith("Not sent");
      expect(door.requests).toEqual([]);
      expect(Arr.map(lines, ({ ended, request }) => [request, ended])).toEqual([
        ["ask-4", "not-sent"],
        ["ask-5", "not-sent"],
      ]);
    }),
  ));

const delivering = (): Door => {
  const fake: Partial<Door> = {
    act: () =>
      // SAFETY: `Deliver` never asks to discard the reply, so it is the results.
      Effect.succeed([{ kind: "deliver", state: "applied", note: "" } as ActionResult] as never),
  };
  // SAFETY: a Deliver calls only `act`.
  return fake as Door;
};

test("actions.log keeps a JSON line per attempt with ids and kinds only, and starts again past 1 MiB", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-actions-log-" });
      const log = yield* actionsLog(dir, 600);
      yield* act(answering([accepted(true)]).reached, "ask-6", answer, log);
      yield* act(
        { machine, desktop: delivering() },
        "say-1",
        {
          _tag: "Deliver",
          runId: "r-2",
          text: "the-deliver-text",
        },
        log,
      );
      const kept = yield* fs.readFileString(`${dir}/actions.log`);
      const [first, second] = Arr.map(Str.split(Str.trim(kept), "\n"), (line) => JSON.parse(line));
      expect(first).toMatchObject({
        door: "board",
        machine: "vm-mk",
        request: "ask-6",
        kind: "Answer",
        about: "r-1",
        attempt: 1,
        ended: "accepted",
      });
      expect(first.at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(second).toMatchObject({ request: "say-1", kind: "Deliver", ended: "accepted" });
      expect(kept).not.toContain("the-answer-value");
      expect(kept).not.toContain("the-deliver-text");
      for (const request of ["ask-7", "ask-8", "ask-9"])
        yield* act(answering([accepted(true)]).reached, request, answer, log);
      expect(yield* fs.readFileString(`${dir}/actions.log.1`)).toContain('"ask-6"');
      expect((yield* fs.stat(`${dir}/actions.log`)).size).toBeLessThanOrEqual(600);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("a log that cannot be written leaves the action's outcome as it was", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-actions-log-" });
      yield* fs.writeFileString(`${dir}/not-a-dir`, "");
      const log = yield* actionsLog(`${dir}/not-a-dir`);
      expect(yield* act(answering([accepted(true)]).reached, "ask-10", answer, log)).toBe(
        "Answered r-1",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("a refusal that quotes the answer is logged without its value", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { lines, log } = logged();
      const door = answering([
        Effect.fail(new HostRefused({ reason: '"The-Answer-Value" is not one of A, B' })),
      ]);
      const failed = yield* act(door.reached, "ask-11", answer, log).pipe(Effect.flip);
      expect(failed.reason).toContain("The-Answer-Value");
      expect(lines[0]!.reason).toContain("is not one of A, B");
      expect(Str.toLowerCase(lines[0]!.reason!)).not.toContain("the-answer-value");
    }),
  ));

test("board and chat writers ending at once at the rotation boundary keep every line", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-actions-log-" });
      const line = (request: string): Attempted => ({
        door: "board",
        machine: "vm-mk",
        request,
        kind: "Answer",
        about: "r-1",
        attempt: 1,
        ended: "accepted",
      });
      const first = yield* actionsLog(dir, 350);
      for (const request of ["ask-a", "ask-b"]) yield* first(line(request));
      const second = yield* actionsLog(dir, 350);
      yield* Effect.all([first(line("ask-c")), second(line("ask-d"))], {
        concurrency: "unbounded",
      });
      const kept = Arr.join(
        [
          yield* fs.readFileString(`${dir}/actions.log.1`),
          yield* fs.readFileString(`${dir}/actions.log`),
        ],
        "",
      );
      for (const request of ["ask-a", "ask-b", "ask-c", "ask-d"])
        expect(kept).toContain(`"${request}"`);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

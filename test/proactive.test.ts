import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { eventsIn, idleAgain, readSaid, remember } from "../src/proactive";
import type { Event } from "../src/proactive";
import { task } from "./support/task";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import type { RunFacts } from "../src/runs";
import { runFacts } from "./support/records";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-proactive-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const record = (over: Partial<RunFacts> & { id: string }) =>
  runFacts({ project: "/repo", created: "2026-09-11T10:00:00.000Z", ...over });

const asking = { name: "scope", prompt: "Which repository?", options: [] };

test("the things worth saying are the things a human would want to know", () => {
  const said = (over: Partial<RunFacts>) => eventsIn([record({ id: "r1", ...over })])[0] ?? null;

  expect(said({ state: "waiting", asking: [asking] })!.text).toContain("waiting on me (scope)");
  expect(said({ state: "waiting", note: "the pane would not take it" })!.text).toContain(
    "parked its work: the pane would not take it",
  );
  expect(said({ state: "succeeded" })!.text).toContain("ended succeeded");
  expect(said({ state: "failed" })!.text).toContain("ended failed");
  expect(said({ state: "stopped" })!.text).toContain("ended stopped");
  const drifted = eventsIn([record({ id: "r1" })], new Map([["r1", "keep-envelope"]]))[0]!;
  expect(drifted.text).toContain("drifted from keep-envelope and Collie could not correct it");
  expect(drifted.key).toBe("r1:drift:keep-envelope");
  expect(
    eventsIn([record({ id: "r1", state: "succeeded" })], new Map([["r1", "keep-envelope"]]))[0]!
      .text,
  ).toContain("ended succeeded");

  expect(said({ state: "failed" })!.run).toBe("r1");
});

test("a release Run awaiting CI or a teammate's approval says nothing consequential; a blocker or its go still does", () => {
  const release = (over: Partial<RunFacts>) =>
    eventsIn([record({ id: "r1", workflow: "release", ...over })]);
  const awaiting = {
    on: "CI and a teammate's approval on group/app!345",
    who: "a teammate",
    since: "2026-10-21T10:00:00.000Z",
  };

  expect(release({ state: "running", awaiting })).toEqual([]);

  const red = "group/app!345 cannot be released: the pipeline at 1d538252 failed (lint).";
  const blocked = release({ state: "waiting", parked: red, note: red, awaiting })[0]!;
  expect(blocked.significance).toBe("consequential");
  expect(blocked.text).toContain("the pipeline at 1d538252 failed");
  const changes = "group/app!345 cannot be released: changes are requested.";
  expect(release({ state: "waiting", parked: changes, note: changes })[0]!.text).toContain(
    "changes are requested",
  );

  const go = {
    name: "go-1",
    prompt: "Release group/app!345?",
    options: [
      { id: "Release", title: "Release" },
      { id: "Finish", title: "Finish" },
    ],
  };
  const asked = release({ state: "waiting", asking: [go], awaiting })[0]!;
  expect(asked.significance).toBe("decision");
  expect(asked.key).toBe("r1:asking:go-1");
});

const unsaid = (events: ReadonlyArray<Event>, said: ReadonlySet<string>) =>
  Arr.filter(events, (event) => !said.has(event.key));

test("a Run that stopped says so once, and says so again only for a different reason", () => {
  const asked = eventsIn([record({ id: "r1", state: "waiting", asking: [asking] })]);
  const said = new Set(Arr.map(asked, (e) => e.key));

  expect(
    unsaid(eventsIn([record({ id: "r1", state: "waiting", asking: [asking] })]), said),
  ).toHaveLength(0);

  const other = eventsIn([
    record({ id: "r1", state: "waiting", asking: [{ ...asking, name: "target" }] }),
  ]);
  expect(unsaid(other, said)).toHaveLength(1);
});

test("several Runs ending together is every one of them, kept for one batch", () => {
  const events = eventsIn([
    record({ id: "r1", state: "succeeded" }),
    record({ id: "r2", state: "failed" }),
    record({ id: "r3", state: "waiting", asking: [asking] }),
  ]);

  expect(Arr.map(unsaid(events, new Set()), (event) => event.run)).toEqual(["r1", "r2", "r3"]);
});

test("a Run says the most pressing thing about it, not every true thing", () => {
  const events = eventsIn(
    [record({ id: "r1", state: "waiting", asking: [asking] })],
    new Map([["r1", "keep-envelope"]]),
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.text).toContain("waiting on me");
});

test("what has been said survives the Home being closed and reopened", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${stateDir}/herd-1`;
      yield* fs.makeDirectory(dir, { recursive: true });

      expect(yield* readSaid(dir)).toEqual(new Set());
      yield* remember(dir, "r1:ended:failed", "2026-09-11T10:00:00.000Z");

      const said = yield* readSaid(dir);
      expect(said.has("r1:ended:failed")).toBe(true);
      const events = eventsIn([record({ id: "r1", state: "failed" })]);
      expect(unsaid(events, said)).toHaveLength(0);
    }),
  ));

test("a Run is named by what a human can find: its workflow and its target", () => {
  const events = eventsIn([
    record({
      id: "r1",
      workflow: "review",
      state: "succeeded",
      settled: { inputs: { target: "mr:mk/collie!65" }, strategies: { target: "diff-target" } },
    }),
  ]);
  expect(events[0]!.text).toContain("(Review · !65)");
});

test("the event carries no action, so speaking first grants nothing", () => {
  const event: Event = eventsIn([record({ id: "r1", state: "failed" })])[0]!;
  expect(Rec.keys(event).sort()).toEqual(["key", "run", "significance", "text"]);
  expect(pipe(event.text, Str.endsWith("?"))).toBe(true);
});

test("noticing something costs a file append, and noticing nothing costs nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* newsPath(stateDir, "herd-abc");
      const quiet = [record({ id: "r1" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(quiet)) yield* appendNews(file, event);
      expect(yield* fs.exists(file)).toBe(false);

      const ended = [record({ id: "r1", state: "failed" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(ended)) yield* appendNews(file, event);
      expect(pendingNews(yield* readNews(file)).items).toHaveLength(1);
    }),
  ));

test("a Run ready to release when it ends is said once as ready, never as ended", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* newsPath(stateDir, "herd-abc");
      const sentence =
        "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it.";
      const ready = new Map([["r1", { at: "1a2b3c4d", sentence }]]);
      const ended = [record({ id: "r1", state: "succeeded" })];

      const events = eventsIn(ended, new Map(), ready);
      expect(events).toEqual([
        {
          run: "r1",
          key: "r1:ready:1a2b3c4d",
          text: `Run r1 (Implement): ${sentence}`,
          significance: "try-it",
        },
      ]);
      for (let tick = 0; tick < 20; tick++)
        for (const event of eventsIn(ended, new Map(), ready)) yield* appendNews(file, event);
      expect(Arr.map(pendingNews(yield* readNews(file)).items, (item) => item.key)).toEqual([
        "r1:ready:1a2b3c4d",
      ]);
    }),
  ));

test("a Reopened agent finishing what it was told is said once, and not while it works", () => {
  const card = (status: string) =>
    task({
      run: "r1",
      state: status === "working" ? "active" : "done",
      reopened: { delivery: "d-1", agent: "builder", told: "merge and tag it", status },
    });
  const seen = new Set<string>();
  const ended = [record({ id: "r1", state: "succeeded" })];
  const said = (status: string) =>
    Arr.filter(eventsIn(ended, new Map(), new Map(), idleAgain([card(status)], seen)), (event) =>
      pipe(event.key, Str.includes(":reopened:")),
    );

  expect(said("idle")).toEqual([]);
  expect(said("working")).toEqual([]);
  expect(said("working")).toEqual([]);
  expect(said("idle")).toEqual([
    {
      run: "r1",
      key: "r1:reopened:d-1",
      text: "Run r1 (Implement): builder has finished what it was told after the Run ended (“merge and tag it”). What came of it?",
      significance: "consequential",
    },
  ]);
  expect(said("idle")).toEqual([]);
});

test("a Reopened agent that goes from working to blocked has not finished what it was told", () => {
  const card = (status: string) =>
    task({
      run: "r1",
      reopened: { delivery: "d-1", agent: "builder", told: "merge it", status },
    });
  const seen = new Set<string>();
  expect(idleAgain([card("working")], seen).size).toBe(0);
  expect(idleAgain([card("blocked")], seen).size).toBe(0);
  expect([...idleAgain([card("idle")], seen).keys()]).toEqual(["r1"]);
});

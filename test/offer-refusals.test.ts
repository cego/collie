import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { readDispositions } from "../src/disposition";
import { currentEnv } from "../src/env";
import { connect, type HostClient } from "../src/host";
import { carryOutAsked } from "../src/run-actions";
import { toolNamed } from "../src/tools";
import { stopHost, until } from "./support/host";
import { recordsAt } from "./support/records";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges } from "./support/forge";
import { collie, proves, type World } from "./support/world";

const MODULES = ["delivers.workflow.ts", "ships.workflow.ts", "stages.workflow.ts"];
const MR = "https://gitlab.cego.dk/cego/app/-/merge_requests/12";

const delivered = Effect.fn("OfferRefusals.delivered")(function* (
  client: HostClient,
  world: World,
  request: string,
  ships = false,
) {
  const { runId } = yield* client.start({
    project: world.project,
    id: "delivers",
    request,
    input: { mr: MR, ships },
  });
  return runId;
});

const settled = (client: HostClient, runId: string, status: "complete" | "failed" | "suspended") =>
  until(
    () => client.run({ runId }),
    (view) => view?.status.status === status,
  );

const unavailable = (client: HostClient, runId: string) =>
  client
    .offers({ runId })
    .pipe(Effect.map((offers) => Arr.map(offers, (one) => [one.id, one.unavailable] as const)));

const refusal = (client: HostClient, runId: string, offer: string, request: string) =>
  client.invoke({ runId, offer, input: {}, request }).pipe(
    Effect.flip,
    Effect.map((refused) => refused.reason),
  );

const shipsRuns = (client: HostClient) =>
  client
    .runs({ task: null })
    .pipe(Effect.map((rows) => Arr.filter(rows, (row) => row.workflow === "ships")));

test(
  "a second Ship of a finished delivery is refused while the first is going, naming it, and starts nothing",
  () =>
    proves(
      "collie-offer-twice-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const runId = yield* delivered(client, world, "req-1");
          yield* settled(client, runId, "complete");
          const first = yield* client.invoke({
            runId,
            offer: "ship",
            input: {},
            request: "ship-1",
          });
          yield* settled(client, first.runId, "suspended");

          const going = `a Ship of ${MR} is still going: ${first.runId}`;
          expect(yield* unavailable(client, runId)).toContainEqual(["ship", going]);
          expect(yield* refusal(client, runId, "ship", "ship-2")).toContain(going);
          expect(Arr.map(yield* shipsRuns(client), (row) => row.runId)).toEqual([first.runId]);
        }),
      MODULES,
    ),
  120_000,
);

test(
  "simultaneous actions without a merge-request input start one child, and retrying its request returns it",
  () =>
    proves(
      "collie-offer-action-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const { runId } = yield* client.start({
            project: world.project,
            id: "offer-ask",
            request: "asks",
            input: {},
          });
          yield* settled(client, runId, "complete");
          const invoke = (request: string) =>
            client.invoke({
              runId,
              offer: "ask",
              input: { mr: MR },
              request,
            });
          const results = yield* Effect.all(
            [invoke("ask-1").pipe(Effect.result), invoke("ask-2").pipe(Effect.result)],
            { concurrency: "unbounded" },
          );
          const runs = yield* shipsRuns(client);
          expect(runs).toHaveLength(1);
          expect(Arr.filter(results, (one) => one._tag === "Success")).toHaveLength(1);
          const first = runs[0]!;
          const going = `a Ask is still going: ${first.runId}`;
          expect(yield* unavailable(client, runId)).toEqual([["ask", going]]);
          expect(yield* refusal(client, runId, "ask", "ask-3")).toContain(going);
          const again = yield* invoke(results[0]?._tag === "Success" ? "ask-1" : "ask-2");
          expect(again).toMatchObject({ runId: first.runId, fresh: false });
        }),
      ["offer-ask.workflow.ts", "ships.workflow.ts"],
    ),
  120_000,
);

test(
  "a finished delivery offers Ship again once the Ship it started has failed",
  () =>
    proves(
      "collie-offer-again-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const runId = yield* delivered(client, world, "req-1");
          yield* settled(client, runId, "complete");
          const first = yield* client.invoke({
            runId,
            offer: "ship",
            input: {},
            request: "ship-1",
          });
          yield* settled(client, first.runId, "suspended");
          yield* client.answer({
            runId: first.runId,
            decision: "go",
            value: "no",
            request: "no-1",
          });
          yield* settled(client, first.runId, "failed");

          expect((yield* client.run({ runId }))?.status.status).toBe("complete");
          expect(yield* unavailable(client, runId)).toContainEqual(["ship", null]);
          const again = yield* client.invoke({
            runId,
            offer: "ship",
            input: {},
            request: "ship-2",
          });
          expect((yield* client.run({ runId: again.runId }))?.parent).toBe(runId);
        }),
      MODULES,
    ),
  120_000,
);

test(
  "a Ship started from one carrier of a merge request refuses it on another through every door, across a restart",
  () =>
    proves(
      "collie-offer-carriers-",
      (world) =>
        Effect.gen(function* () {
          const env = yield* currentEnv;
          let client = yield* connect(world.state);
          const a = yield* delivered(client, world, "req-a");
          const b = yield* delivered(client, world, "req-b");
          yield* settled(client, a, "complete");
          yield* settled(client, b, "complete");
          const first = yield* client.invoke({
            runId: a,
            offer: "ship",
            input: {},
            request: "ship-a",
          });
          yield* settled(client, first.runId, "suspended");
          const going = `a Ship of ${MR} is still going: ${first.runId}`;

          const everyDoor = (round: string) =>
            Effect.gen(function* () {
              const cli = yield* collie(world, ["run", "action", b, "ship"]);
              expect(cli.envelope.error?.message).toContain(going);
              const [taken] = yield* carryOutAsked(
                env,
                [{ kind: "take_offer", run: b, offer: "ship" }],
                {
                  origin: "board",
                  requestId: `board-${round}`,
                },
              );
              expect(taken).toMatchObject({
                state: "failed",
                note: expect.stringContaining(going),
              });
              const chat = yield* toolNamed("collie_do")!.call(env, {
                actions: [{ kind: "take_offer", run: b, offer: "ship" }],
              });
              expect(chat).toContain(going);
              expect(yield* unavailable(client, b)).toContainEqual(["ship", going]);
              expect(Arr.map(yield* shipsRuns(client), (row) => row.runId)).toEqual([first.runId]);
            });

          yield* everyDoor("before");
          yield* stopHost(world.state);
          client = yield* connect(world.state);
          yield* everyDoor("after");
        }).pipe(Effect.provide(recordsAt(world.state))),
      MODULES,
    ),
  240_000,
);

test(
  "a delivery started to ship lists its own Ship unavailable while that child is going, naming it",
  () =>
    proves(
      "collie-offer-child-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const runId = yield* delivered(client, world, "req-1", true);
          const [child] = yield* until(
            () => shipsRuns(client),
            (rows) => rows.length === 1,
          );
          yield* settled(client, child!.runId, "suspended");

          const going = `a Ship of ${MR} is still going: ${child!.runId}`;
          expect(yield* unavailable(client, runId)).toContainEqual(["ship", going]);
          expect(yield* refusal(client, runId, "ship", "ship-1")).toContain(going);
          expect(yield* shipsRuns(client)).toHaveLength(1);
        }),
      MODULES,
    ),
  120_000,
);

test(
  "a delivery whose merge request the forge reads merged refuses Ship and Stage, and one unknown refuses neither",
  () =>
    proves(
      "collie-offer-merged-",
      (world) =>
        Effect.gen(function* () {
          let client = yield* connect(world.state);
          const runId = yield* delivered(client, world, "req-1");
          yield* settled(client, runId, "complete");
          expect(yield* unavailable(client, runId)).toEqual([
            ["ship", null],
            ["stage", null],
          ]);

          yield* stopHost(world.state);
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const forge = yield* forgeOnPath(bin, "gitlab", {
            installed: true,
            loggedIn: ["gitlab.cego.dk"],
            login: "mk",
            mrs: [{ project: "gitlab.cego.dk/cego/app", iid: "12", state: "merged" }],
          });
          const api = yield* serveForges(forge);
          yield* bin.restore();
          const listed = yield* collie(world, ["run", "actions", runId], {
            PATH: `${bin.dir}:${Bun.env.PATH}`,
            COLLIE_FORGE_API: api,
          });
          expect(listed.envelope.ok).toBe(true);
          client = yield* connect(world.state);
          yield* until(
            () => readDispositions(`${world.state}/runs/${runId}`),
            (lines) => Arr.some(lines, (line) => line.kind === "merged"),
          );
          const merged = `${MR} is merged`;
          expect(yield* unavailable(client, runId)).toEqual([
            ["ship", merged],
            ["stage", merged],
          ]);
          expect(yield* refusal(client, runId, "ship", "ship-1")).toContain(merged);
          expect(yield* refusal(client, runId, "stage", "stage-1")).toContain(merged);
          expect(yield* client.runs({ task: null })).toHaveLength(1);
        }),
      MODULES,
    ),
  120_000,
);

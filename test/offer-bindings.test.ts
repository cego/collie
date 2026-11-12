// What an offer binds is Collie's to fill and nobody's to type: the values it gives, and the
// inputs only the started workflow's own orchestration sets. What it ships it says.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import * as Rec from "effect/Record";
import { Effect, Schema } from "effect";
import * as Option from "effect/Option";
import { connect, frontDoor, socketOf, type HostClient } from "../src/host";
import { currentEnv } from "../src/env";
import { makeOffer, type FlowPrompts } from "../src/flows";
import { stopHost, until } from "./support/host";
import { proves, save, type World } from "./support/world";

const MR = "https://gitlab.example.com/group/app/-/merge_requests/7";

const drawn = Schema.decodeUnknownEffect(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const startedWith = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const projectOf = Effect.fn("OfferBindingsTest.project")(function* (world: World) {
  const project = `${world.project}/work`;
  yield* save(`${project}/.collie/workflows`, [
    "hands-over.workflow.ts",
    "ship-target.workflow.ts",
    "merges-by-action.workflow.ts",
  ]);
  return project;
});

const finished = Effect.fn("OfferBindingsTest.finished")(function* (
  client: HostClient,
  project: string,
  id = "hands-over",
) {
  const started = yield* client.start({
    project,
    id,
    request: "req-1",
    input: { mr: MR },
  });
  yield* until(
    () => client.run({ runId: started.runId }),
    (view) => view?.status.status === "complete",
  );
  return started.runId;
});

test(
  "Merge and Release say what they ship, ask only for a human's option, and start with what they bind",
  () =>
    proves(
      "collie-offer-bindings-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);

          const offers = yield* client.offers({ runId }).pipe(Effect.orDie);
          expect(Arr.map(offers, (one) => [one.id, one.title, one.ships, one.confirm])).toEqual([
            ["release", "Release", "release", "Merges it, tags it and deploys the tag."],
            ["merge", "Merge", "merge", "Merges it and stops: nothing is tagged or deployed."],
          ]);
          for (const offer of offers)
            expect(Rec.keys((yield* drawn(offer.arguments)).properties)).toEqual(["notify"]);

          const started = yield* client
            .invoke({ runId, offer: "merge", input: { notify: false }, request: "act-1" })
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.parent).toBe(runId);
          expect(done?.status.status).toBe("complete");
          const value = done?.status.status === "complete" ? done.status.value : null;
          expect(yield* startedWith(value)).toEqual({ mr: MR, notify: false, ship: "merge" });
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "an action draws neither the arguments it binds nor its target's internal inputs, and starts with what it binds",
  () =>
    proves(
      "collie-offer-action-bindings-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project, "merges-by-action").pipe(Effect.orDie);

          const [merge] = yield* client.offers({ runId }).pipe(Effect.orDie);
          const drawnAs = yield* drawn(merge?.arguments);
          expect(Rec.keys(drawnAs.properties)).toEqual(["notify"]);
          expect(drawnAs.required ?? []).toEqual([]);

          const started = yield* client
            .invoke({ runId, offer: "merge", input: {}, request: "act-1" })
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          const value = done?.status.status === "complete" ? done.status.value : null;
          expect(yield* startedWith(value)).toEqual({ mr: MR, ship: "merge" });
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "an offer refuses a value for what it binds or for an internal input, and starts nothing",
  () =>
    proves(
      "collie-offer-internal-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);

          for (const [input, named, request] of [
            [{ ship: "release" }, "ship", "act-1"],
            [{ merge_only: true }, "merge_only", "act-2"],
            [{ together: [MR] }, "together", "act-3"],
          ] as const) {
            const refused = yield* client
              .invoke({ runId, offer: "merge", input, request })
              .pipe(Effect.flip, Effect.orDie);
            expect("reason" in refused ? refused.reason : String(refused)).toContain(`"${named}"`);
          }
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(1);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "what a project can start leaves out the inputs only another workflow's orchestration sets",
  () =>
    proves(
      "collie-startable-internal-",
      (world) =>
        Effect.gen(function* () {
          yield* projectOf(world);
          yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "desktop", from: { client: "mk-pc" } });
          const startable = yield* door.workflows({ project: `${world.project}/work` });
          const target = Option.getOrUndefined(
            Arr.findFirst(startable, (one) => one.id === "ship-target"),
          );
          expect(Arr.map(target?.inputs ?? [], (one) => one.name)).toEqual([
            "mr",
            "ship",
            "notify",
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "the TUI board asks again for what a field cannot take, and takes Merge only once its consequences are confirmed",
  () =>
    proves(
      "collie-offer-tui-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);
          const asked: string[] = [];
          const headers: string[] = [];
          const answers = ["maybe", "false", "true"];
          const picks = ["cancel", "take"];
          const prompts: FlowPrompts = {
            menu: (items, options) => {
              headers.push(options?.header ?? "");
              const id = picks.shift();
              return Effect.succeed(Option.getOrNull(Arr.findFirst(items, (one) => one.id === id)));
            },
            ask: (question) => {
              asked.push(question);
              return Effect.succeed(answers.shift() ?? null);
            },
          };

          expect(yield* makeOffer(yield* currentEnv, prompts, runId, "merge")).toBeNull();
          expect(asked).toEqual(["notify? (optional)", "Notify must be yes or no. notify?"]);
          expect(headers).toEqual(["Merges it and stops: nothing is tagged or deployed."]);
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(1);

          const note = yield* makeOffer(yield* currentEnv, prompts, runId, "merge");
          expect(note).toStartWith("Started run ");
          const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
          const child = Option.getOrUndefined(Arr.findFirst(runs, (one) => one.parent === runId));
          expect(child?.input).toEqual({ mr: MR, notify: true, ship: "merge" });
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect, Option, Stream } from "effect";
import { cardActions, primaryAction, type TaskView } from "../src/board-model";
import { connect, frontDoor, socketOf } from "../src/host";
import { stopHost, until } from "./support/host";
import { proves } from "./support/world";

const MODULES = ["card-delivery.workflow.ts", "ships.workflow.ts", "stages.workflow.ts"];
const MR = "https://gitlab.cego.dk/cego/app/-/merge_requests/12";
const OTHER = "https://gitlab.cego.dk/cego/api/-/merge_requests/7";

const cards = (state: string) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(state));
    const first = yield* Stream.runHead(door.board());
    const snapshot = Option.getOrThrow(first);
    if (snapshot._tag !== "Snapshot") throw new Error("expected board snapshot");
    return snapshot.tasks;
  });
const offers = (view: TaskView) =>
  Arr.flatMap(cardActions(view), (action) => (action.kind === "offer" ? [action.offer] : []));

test(
  "a fan-out card invokes Release on its Change, and the card keeps its Offers and refusal across a host restart",
  () =>
    proves(
      "collie-card-offers-",
      (world) =>
        Effect.gen(function* () {
          let client = yield* connect(world.state);
          const parent = yield* client.start({
            project: world.project,
            id: "card-delivery",
            request: "fan",
            taskLabel: "Deliver changes",
            input: { mrs: [MR, OTHER] },
          });
          const parentView = yield* until(
            () => client.run({ runId: parent.runId }),
            (view) => view?.status.status === "complete",
          );
          const [before] = yield* until(
            () => cards(world.state),
            (cards) => Arr.some(cards, (card) => card.mrs?.length === 2),
          );
          const owner = Option.getOrThrow(Arr.findFirst(before!.mrs!, (mr) => mr.mr === MR)).run;
          expect(owner).not.toBe(parent.runId);
          expect(Arr.map(offers(before!), (offer) => offer.run)).not.toContain(parent.runId);
          expect(Arr.map(offers(before!), (offer) => offer.title)).toEqual([
            "Release app!12",
            "Stage app!12",
            "Release api!7",
            "Stage api!7",
          ]);
          const action = Option.getOrThrow(
            Arr.findFirst(
              cardActions(before!),
              (action) => action.kind === "offer" && action.offer.run === owner,
            ),
          );
          if (action.kind !== "offer") throw new Error("expected Release action");
          const release = yield* client.invoke({
            runId: action.offer.run!,
            offer: action.offer.id,
            input: {},
            request: "release",
          });
          const running = yield* until(
            () => client.run({ runId: release.runId }),
            (view) => view?.status.status === "suspended",
          );
          expect(running!.parent).toBe(owner);
          const reason = `a Release of ${MR} is still going: ${release.runId}`;
          const carrier = yield* client.start({
            project: world.project,
            id: "card-delivery",
            request: "another-carrier",
            task: parentView!.task!,
            input: { mrs: [MR] },
          });
          yield* until(
            () => client.run({ runId: carrier.runId }),
            (view) => view?.status.status === "complete",
          );
          const [going] = yield* until(
            () => cards(world.state),
            (cards) =>
              Arr.some(cards, (card) =>
                Arr.some(offers(card), (offer) => offer.unavailable === reason),
              ),
          );
          expect(Option.getOrThrow(Arr.findFirst(going!.mrs!, (mr) => mr.mr === MR)).run).toBe(
            carrier.runId,
          );
          expect(
            Option.getOrThrow(
              Arr.findFirst(
                offers(going!),
                (offer) => offer.run === carrier.runId && offer.id === "release",
              ),
            ).unavailable,
          ).toBe(reason);
          const refused = yield* client
            .invoke({ runId: carrier.runId, offer: "release", input: {}, request: "again" })
            .pipe(Effect.flip);
          expect(refused.reason).toContain(reason);
          expect(primaryAction(going!)?.kind).not.toBe("offer");
          const projection = (card: TaskView) => ({
            id: card.id,
            run: card.run,
            state: card.state,
            sentence: card.sentence,
            mrs: card.mrs,
            offers: offers(card),
            primary: primaryAction(card),
          });
          yield* stopHost(world.state);
          client = yield* connect(world.state);
          const [after] = yield* until(
            () => cards(world.state),
            (cards) =>
              Arr.some(cards, (card) =>
                Arr.some(offers(card), (offer) => offer.unavailable === reason),
              ),
          );
          expect(projection(after!)).toEqual(projection(going!));
          const rows = yield* client.runs({ task: null });
          expect(
            Arr.map(
              Arr.filter(rows, (row) => row.workflow === "ships"),
              (row) => row.runId,
            ),
          ).toEqual([release.runId]);
        }),
      MODULES,
    ),
  120_000,
);

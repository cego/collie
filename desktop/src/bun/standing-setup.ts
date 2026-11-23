import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, Stream, SubscriptionRef } from "effect";
import { PLUGIN_ID } from "../../../src/env";
import { ownInventory, readOwnWords } from "../../../src/own-words";
import type { OwnInventory, OwnWords } from "../../../src/own-words-model";
import procedure from "../../../prompts/standing-direction-setup.md" with { type: "text" };
import type { ActionFailed, DesktopSettingsChange, OnboardRun } from "../shared/flock";
import { declined, offersSetup, setupTurn } from "../shared/standing-setup";
import type { OfferFacts, SetupChoice } from "../shared/standing-setup";
import { refusal } from "./chat";
import type { FlockConversation } from "./chat";

export interface Place {
  readonly computer: string;
  readonly inventory: Effect.Effect<OwnInventory, string>;
  readonly read: Effect.Effect<OwnWords, string>;
}

export const setupInventory = (places: ReadonlyArray<Place>) =>
  Effect.forEach(
    places,
    ({ computer, inventory }) =>
      inventory.pipe(
        Effect.map(({ stores }) => ({ computer, stores })),
        Effect.catch((problem) => Effect.succeed({ computer, stores: [], problem })),
      ),
    { concurrency: "unbounded" },
  );

export const setUp = (
  choice: SetupChoice,
  places: ReadonlyArray<Place>,
  chat: Pick<FlockConversation, "reopen" | "send">,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const read =
        choice === "ask"
          ? null
          : yield* Effect.forEach(
              places,
              ({ computer, read }) =>
                read.pipe(
                  Effect.map((words) => ({ computer, words })),
                  Effect.catch((problem) => Effect.succeed({ computer, problem })),
                ),
              { concurrency: "unbounded" },
            );
      const refused = yield* chat.reopen(null);
      return refused === null
        ? chat.send(setupTurn(procedure, read), null, false)
        : Stream.make(refusal(refused));
    }),
  );

export const setupOffer = Effect.fn("StandingSetup.offer")(function* (opts: {
  readonly facts: () => Omit<OfferFacts, "connected">;
  readonly save: (change: DesktopSettingsChange) => Effect.Effect<unknown, ActionFailed>;
}) {
  const offered = yield* SubscriptionRef.make(false);
  const chosen = yield* SubscriptionRef.make<SetupChoice | null>(null);
  const ask = (connected: boolean) =>
    Effect.suspend(() => SubscriptionRef.set(offered, offersSetup({ ...opts.facts(), connected })));
  return {
    offered,
    chosen,
    choose: (choice: SetupChoice) =>
      SubscriptionRef.set(offered, false).pipe(Effect.andThen(SubscriptionRef.set(chosen, choice))),
    take: SubscriptionRef.getAndSet(chosen, null),
    directionChanged: Effect.suspend(() =>
      opts.facts().direction === undefined ? Effect.void : SubscriptionRef.set(offered, false),
    ),
    launched: ask(true),
    onboarded: (run: OnboardRun) => (run.ready === true ? ask(true) : Effect.void),
    taken: SubscriptionRef.set(offered, false),
    decline: (forGood: boolean) =>
      opts
        .save(declined(forGood, opts.facts().version))
        .pipe(Effect.andThen(SubscriptionRef.set(offered, false))),
  };
});

export const thisComputer = (home: string) => {
  const places = { home, stateDir: `${home}/.local/state/herdr/plugins/${PLUGIN_ID}` };
  return {
    computer: "this computer",
    inventory: ownInventory(places).pipe(Effect.provide(BunServices.layer)),
    read: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => readOwnWords(places, now)),
      Effect.provide(BunServices.layer),
    ),
  };
};

// Desktop's side of helping the human write their Standing direction: the offer, the
// dialog's Inventory, and the setup conversation the human chose there.

import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, Stream, SubscriptionRef } from "effect";
import { PLUGIN_ID } from "../../../src/env";
import { ownInventory, readOwnWords } from "../../../src/own-words";
import type { OwnInventory, OwnWords } from "../../../src/own-words-model";
import procedure from "../../../prompts/standing-direction-setup.md" with { type: "text" };
import type { AguiEvent } from "../shared/agui";
import type { ActionFailed, DesktopSettingsChange, OnboardRun } from "../shared/flock";
import {
  type ComputerStores,
  type ComputerWords,
  declined,
  type OfferFacts,
  offersSetup,
  type SetupChoice,
  setupTurn,
} from "../shared/standing-setup";
import { type FlockConversation, refusal } from "./chat";

/** A computer the human may have sessions on, with its host's two answers on Desktop's door. */
export interface Place {
  readonly computer: string;
  readonly inventory: Effect.Effect<OwnInventory, string>;
  readonly read: Effect.Effect<OwnWords, string>;
}

/** What the dialog shows before any choice: no message text, and nothing started. */
export const setupInventory = (places: ReadonlyArray<Place>) =>
  Effect.forEach(
    places,
    ({ computer, inventory }): Effect.Effect<ComputerStores> =>
      inventory.pipe(
        Effect.map(({ stores }) => ({ computer, stores })),
        Effect.catch((problem) => Effect.succeed({ computer, stores: [], problem })),
      ),
    { concurrency: "unbounded" },
  );

/** The only caller of Read: the human's choice in the dialog. */
export const setUp = (
  choice: SetupChoice,
  places: ReadonlyArray<Place>,
  chat: Pick<FlockConversation, "reopen" | "send">,
): Stream.Stream<AguiEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const read =
        choice === "ask"
          ? null
          : yield* Effect.forEach(
              places,
              ({ computer, read }): Effect.Effect<ComputerWords> =>
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

/** Whether Desktop offers the setup, asked at launch and when a Machine's onboarding finishes. */
export const setupOffer = Effect.fn("StandingSetup.offer")(function* (opts: {
  readonly facts: () => Omit<OfferFacts, "connected">;
  readonly save: (change: DesktopSettingsChange) => Effect.Effect<unknown, ActionFailed>;
}) {
  const offered = yield* SubscriptionRef.make(false);
  const ask = (connected: boolean) =>
    Effect.suspend(() => SubscriptionRef.set(offered, offersSetup({ ...opts.facts(), connected })));
  return {
    offered,
    /** Desktop launched, and a Machine is connected. */
    launched: ask(true),
    /** A finished onboarding has its Machine within reach. */
    onboarded: (run: OnboardRun) => (run.ready === true ? ask(true) : Effect.void),
    /** The offer was taken up. */
    taken: SubscriptionRef.set(offered, false),
    decline: (forGood: boolean) =>
      opts
        .save(declined(forGood, opts.facts().version))
        .pipe(Effect.andThen(SubscriptionRef.set(offered, false))),
  };
});

/** Desktop's own computer, read in-process, where it is no Machine of the Flock. */
export const thisComputer = (home: string): Place => {
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

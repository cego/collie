// Helping the human write their Standing direction: Desktop's offer, its consent dialog, and
// the choice made there, which the Flock chat takes up.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SetupChoice } from "../../../src/shared/standing-setup";
import { FlockClient, setupChosenAtom, setupOfferAtom } from "../flock";
import { failureOf } from "./useActions";

const inventoryAtom = FlockClient.mutation("setupInventory");
const declineAtom = FlockClient.mutation("declineSetup");
const chooseAtom = FlockClient.mutation("chooseSetup");
const takeAtom = FlockClient.mutation("takeSetup");

export const useStandingSetup = () => {
  const open = useState("standing-setup-open", () => false);
  const { value: offered } = useHeld(() => setupOfferAtom);
  const { value: waiting } = useHeld(() => setupChosenAtom);
  const inventory = useAtomSet(() => inventoryAtom, { mode: "promiseExit" });
  const decline = useAtomSet(() => declineAtom, { mode: "promiseExit" });
  const chooseSetup = useAtomSet(() => chooseAtom, { mode: "promiseExit" });
  const take = useAtomSet(() => takeAtom, { mode: "promiseExit" });
  return {
    offered: computed(() => offered.value === true),
    open,
    /** Where each computer keeps the human's sessions; asking takes the offer up. */
    inventory: () =>
      inventory({ payload: undefined }).then((exit) => (Exit.isSuccess(exit) ? exit.value : [])),
    /** Why it could not be kept, or null. */
    decline: (forGood: boolean) =>
      decline({ payload: { forGood } }).then((exit) => {
        open.value = false;
        return Exit.isFailure(exit) ? failureOf(exit.cause).reason : null;
      }),
    /** Held by Desktop for the Flock chat, which may be in another window. */
    choose: (choice: SetupChoice) => {
      open.value = false;
      void chooseSetup({ payload: { choice } });
    },
    /** Whether a choice waits for a Flock chat to take it. */
    waiting: computed(() => (waiting.value ?? null) !== null),
    /** The waiting choice, if this chat is the one to take it. */
    take: () =>
      take({ payload: undefined }).then((exit) => (Exit.isSuccess(exit) ? exit.value : null)),
  };
};

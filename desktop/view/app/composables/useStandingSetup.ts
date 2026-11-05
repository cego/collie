// Helping the human write their Standing direction: Desktop's offer, its consent dialog, and
// the choice made there, which the Flock chat takes up.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { SetupChoice } from "../../../src/shared/standing-setup";
import { FlockClient, setupOfferAtom } from "../flock";
import { failureOf } from "./useActions";

const inventoryAtom = FlockClient.mutation("setupInventory");
const declineAtom = FlockClient.mutation("declineSetup");

export const useStandingSetup = () => {
  const open = useState("standing-setup-open", () => false);
  /** The choice made in the dialog, until the Flock chat takes it up. */
  const chosen = useState<SetupChoice | null>("standing-setup-chosen", () => null);
  const { value: offered } = useHeld(() => setupOfferAtom);
  const inventory = useAtomSet(() => inventoryAtom, { mode: "promiseExit" });
  const decline = useAtomSet(() => declineAtom, { mode: "promiseExit" });
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
    choose: (choice: SetupChoice) => {
      open.value = false;
      chosen.value = choice;
    },
    chosen,
  };
};

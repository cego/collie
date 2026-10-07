// Where Go to pane last found each card's pane, by card key: the location the card shows,
// and the herdr client's command where none could be opened for it.

import type { PaneAt } from "../../../../src/board-model";
import type { PlacedTask } from "../../../src/shared/flock";
import { paneWhere } from "../../../src/shared/terminal-input";

interface Shown {
  readonly where: string;
  readonly command: string | null;
}

/** A card, as far as finding its pane goes. */
type Card = Pick<PlacedTask, "key" | "installation" | "machine" | "task">;

const shown = reactive(new Map<string, Shown>());

export const usePanes = () => {
  const { goToPane } = useActions();
  const toast = useToast();
  return {
    shownFor: (key: string) => shown.get(key) ?? null,
    forget: (key: string) => shown.delete(key),
    /** The pane is shown in Desktop, here. */
    showing: (placed: Card, at: PaneAt) =>
      shown.set(placed.key, { where: paneWhere(placed.machine, at), command: null }),
    /** A new herdr client attached to the pane's session, in a terminal on this computer. */
    openInHerdr: (placed: Card) =>
      goToPane(placed.installation, placed.task.run).then((went) => {
        if (went === null) return;
        const where = paneWhere(placed.machine, went.at);
        shown.set(placed.key, { where, command: went.opened ? null : went.command });
        toast.add(
          went.opened
            ? { title: `Opened ${where} in a terminal`, color: "success" }
            : { title: "No terminal found: copy the command on the card", color: "warning" },
        );
      }),
  };
};

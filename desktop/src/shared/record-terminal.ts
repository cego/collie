// What a card's record decides about its Terminal tab.

/**
 * Offered while the Run's Machine is reached, and kept while it is the tab shown, so a
 * dropped connection says why and offers Reattach rather than taking the pane away.
 */
export const offersTerminal = (asOf: number | null, chosen: string | undefined) =>
  asOf === null || chosen === "terminal";

/** Only Go to pane, finding no pane to show, opens herdr's own client instead. */
export const opensHerdrWithoutPane = (asked: string | null) => asked === "terminal";

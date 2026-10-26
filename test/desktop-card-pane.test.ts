import { expect, test } from "bun:test";
import { paneLine } from "../desktop/src/shared/terminal-input";

test("a card names its pane by its tab first, so a cut line keeps what tells panes apart", () => {
  expect(
    paneLine({
      session: null,
      workspace: "Collie | Flow Desktop UX and performance polish",
      tab: "Implementer",
    }),
  ).toBe("Implementer · Collie | Flow Desktop UX and performance polish");
});

test("a pane with no tab is named by its workspace", () => {
  expect(paneLine({ session: null, workspace: "Collie | Docs", tab: null })).toBe("Collie | Docs");
});

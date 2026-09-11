// The Focus a test starts from. Shared rather than copied per file, because it is the
// one fixture that grows every time the tab learns to look at something new — `tail` and
// `reviewPages` were each added to two identical copies in lockstep.

import type { Focus } from "../../src/ui/state";

/** What is being looked at, with the parts a test does not care about at rest. */
export function focus(over: Partial<Focus> = {}): Focus {
  return {
    view: "runs",
    filter: { kind: "workspace", id: "w1" },
    origin: "w1",
    steerDraft: null,
    previewing: null,
    shown: ["runs"],
    selected: null,
    tail: false,
    reviewPages: 1,
    nonce: 0,
    ...over,
  };
}

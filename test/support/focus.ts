import type { Focus } from "../../src/ui/state";

export function focus(over: Partial<Focus> = {}) {
  const returned: Focus = {
    view: "runs",
    filter: { kind: "workspace", id: "w1" },
    origin: "w1",
    previewing: null,
    shown: ["runs"],
    selected: null,
    tail: false,
    reviewPages: 1,
    nonce: 0,
    ...over,
  };
  return returned;
}

import { Effect } from "effect";
import type { Channel, SubmitOutcome } from "../../src/dispatcher";

export function fakeChannel(
  prompted: Array<string>,
  outcome: SubmitOutcome = { ok: true, id: "compaction-1" },
) {
  const returned: Channel = {
    agent: "test",
    submit: (text) =>
      Effect.sync(() => {
        prompted.push(text);
        return outcome;
      }),
  };
  return returned;
}

import { Effect } from "effect";
import type { Channel, SubmitOutcome } from "../../src/dispatcher";

/**
 * A Dispatcher channel that records what it was given. Compaction adapters now send
 * through a channel rather than herdr, so a test that scripts one needs this instead of
 * a fake `agentPrompt`.
 */
export function fakeChannel(
  prompted: string[],
  outcome: SubmitOutcome = { ok: true, id: "compaction-1" },
): Channel {
  return {
    agent: "test",
    submit: (text) =>
      Effect.sync(() => {
        prompted.push(text);
        return outcome;
      }),
  };
}

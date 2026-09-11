import { Effect } from "effect";
import {
  COMPACTION_OFF,
  Unsubmitted,
  type CompactionOutcome,
  type CompactionPorts,
} from "../../src/compaction";
import { loadDefaults } from "../../src/config";
import type { Channel, SubmitOutcome } from "../../src/dispatcher";

/**
 * The user defaults a sandbox of fake agents wants: whatever is configured, with
 * compaction off. Under the shipped threshold every launch here would gate on — and
 * install controls for — whatever version of the harness this machine happens to have,
 * which is not what any of those tests are about. A test that scripts a harness
 * interface asks for compaction and gets the shipped default back.
 */
export const testDefaults = Effect.fn("testSupport.testDefaults")(function* (configDir: string) {
  return Object.assign(yield* loadDefaults(configDir), { compactAtTokens: COMPACTION_OFF });
});

export interface Scripted {
  ports: CompactionPorts;
  installs: string[];
  requests: string[];
  usageReads: number;
}

/**
 * One harness's official interface, scripted. `usage` and `poll` are read from lists so
 * a test can say what the harness reports at each boundary, and the recorded requests
 * are what proves whether Collie asked for compaction at all. Registered under `claude`
 * unless a test names another: the policy is shared, so which harness it is registered
 * under is exactly the thing a four-harness check varies.
 */
export function scriptedPort(opts: {
  usage?: ReadonlyArray<number | null | Error>;
  poll?: ReadonlyArray<CompactionOutcome | null>;
  /**
   * How asking for a compaction goes. `unsubmitted` is a request that never left, the
   * only failure that may release the waiting work; `failed` is one that may have left
   * before it broke, which is an outcome nobody has established; `unobserved` left
   * through the human's channel with no turn seen to come of it.
   */
  request?: "unsubmitted" | "failed" | "unobserved";
  /** Which harness's interface this stands in for. Defaults to the tests' own. */
  harness?: string;
}): Scripted {
  const installs: string[] = [];
  const requests: string[] = [];
  const usage = [...(opts.usage ?? [])];
  const poll = [...(opts.poll ?? [])];
  const scripted: Scripted = {
    installs,
    requests,
    usageReads: 0,
    ports: {
      [opts.harness ?? "claude"]: {
        gate: () => Effect.void,
        install: (ctx) =>
          Effect.sync(() => {
            installs.push(ctx.agent);
            return { args: ["--scripted-controls", ctx.dir] };
          }),
        usage: () =>
          Effect.suspend(() => {
            scripted.usageReads += 1;
            const next = usage.shift();
            if (next instanceof Error) return Effect.fail(next);
            return Effect.succeed(next ?? null);
          }),
        request: (_ctx, requestId) =>
          Effect.suspend(() => {
            requests.push(requestId);
            if (opts.request === "unsubmitted") {
              return Effect.fail(new Unsubmitted({ message: "the channel refused it" }));
            }
            if (opts.request === "failed") {
              return Effect.fail(new Error("the connection closed"));
            }
            if (opts.request === "unobserved") return Effect.succeed("unobserved" as const);
            // No verdict of its own, as an adapter off the human's channel answers.
            return Effect.succeed(null);
          }),
        poll: () => Effect.succeed(poll.length > 0 ? (poll.shift() ?? null) : null),
      },
    },
  };
  return scripted;
}

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

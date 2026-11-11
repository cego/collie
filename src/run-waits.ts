// What holds one Run up now, read once for every view that shows it.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect } from "effect";
import type * as Types from "effect/Types";
import type { Awaiting } from "./awaiting";
import { boardOption, type BoardAgent, type Question } from "./board-model";
import type { UsageWait } from "./flow";
import { memoryWaitOf, type MemoryWait } from "./memory-wait";
import { pendingFor, type ProposalLine, type ProposalRecord } from "./proposals";
import { settled, type RunFacts } from "./runs";

const NO_AGENT_TO_STEER =
  "no agent of this Run is live to redirect: pick a solution or stop the Run";

export interface RunWaits {
  /** In asked order. */
  readonly questions: ReadonlyArray<Question>;
  readonly proposals: ReadonlyArray<ProposalRecord>;
  /** Its agent herdr reports at a dialog of its harness's: the pane a human must go to. */
  readonly blocked: BoardAgent | null;
  /** While it waits with no question open; a null reason is one it never recorded. */
  readonly parked: { readonly reason: string | null } | null;
  readonly held: boolean;
  readonly memory: MemoryWait | null;
  readonly awaiting: Awaiting | null;
  readonly usage: UsageWait | null;
}

export const runWaits = Effect.fn("RunWaits.of")(function* (
  run: RunFacts,
  proposals: ReadonlyArray<ProposalLine>,
  agents: ReadonlyArray<BoardAgent>,
  now: number,
) {
  const waits: RunWaits = {
    questions: Arr.map(run.asking, (asked) => {
      const question: Types.Mutable<Question> = {
        kind: "question",
        run: run.id,
        id: asked.name,
        step: run.workflow,
        topic: asked.name,
        text: asked.prompt,
        options: Arr.map(asked.options, boardOption),
      };
      if (asked.hold !== undefined) question.hold = asked.hold;
      if (asked.shortfall !== undefined) question.shortfall = asked.shortfall;
      if (asked.shipping !== undefined) question.shipping = asked.shipping;
      question.steer = Arr.some(agents, (agent) => agent.name === asked.steer)
        ? { agent: asked.steer ?? null, why: null }
        : { agent: null, why: NO_AGENT_TO_STEER };
      return question;
    }),
    proposals: pendingFor(proposals, run.id, now),
    blocked:
      Option.getOrUndefined(
        Arr.findFirst(agents, (agent) => agent.run === run.id && agent.status === "blocked"),
      ) ?? null,
    parked: run.state === "waiting" && run.asking.length === 0 ? { reason: run.parked } : null,
    // A hold left on a Run that ended holds nothing, and a finished Run refuses its release.
    held: run.held && !settled(run),
    memory: yield* memoryWaitOf(run.dir),
    awaiting: run.awaiting,
    usage: run.usage ?? null,
  };
  return waits;
});

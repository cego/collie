// What holds one Run up now: every Wait the board and the Flow read for it.

import { Effect } from "effect";
import type { Awaiting } from "./awaiting";
import type { BoardAgent, Question } from "./board-model";
import { memoryWaitOf, type MemoryWait } from "./memory-wait";
import { pendingFor, type ProposalLine, type ProposalRecord } from "./proposals";
import { settled, type RunFacts } from "./runs";

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
}

export const runWaits = Effect.fn("RunWaits.of")(function* (
  run: RunFacts,
  proposals: ReadonlyArray<ProposalLine>,
  agents: ReadonlyArray<BoardAgent>,
  now: number,
) {
  const waits: RunWaits = {
    questions: run.asking.map((asked) => ({
      kind: "question",
      run: run.id,
      id: asked.name,
      step: run.workflow,
      topic: asked.name,
      text: asked.prompt,
      options: asked.options.map((option) => ({ id: option, title: option, subtitle: null })),
    })),
    proposals: pendingFor(proposals, run.id, now),
    blocked: agents.find((agent) => agent.run === run.id && agent.status === "blocked") ?? null,
    parked: run.state === "waiting" && run.asking.length === 0 ? { reason: run.parked } : null,
    // A hold left on a Run that ended holds nothing, and a finished Run refuses its release.
    held: run.held && !settled(run),
    memory: yield* memoryWaitOf(run.dir),
    awaiting: run.awaiting,
  };
  return waits;
});

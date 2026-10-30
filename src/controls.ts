// The controls an operator sets over a Run, as the host keeps them: one file each.

import { Effect, FileSystem } from "effect";

export const HOLD = "hold";
export const STOP = "stop";

/**
 * What a workflow reads about its own run: the controls an operator has set over it, and
 * the question it is waiting on.
 *
 * A control is one file in the host's own directory, and the host is its only writer —
 * no client writes one and nothing consumes it as a command. It stays a file rather than
 * a row because a workflow reads it at its boundaries, from the engine's own fiber:
 * answering that read out of this process's memory or its database settles the boundary
 * fast enough to race a resume, and the run parks again before the resume has landed.
 * `docs/adr/0021-one-host-answers-for-a-run.md` has the measurement.
 */
export const controlPath = (dir: string, control: string, runId: string): string =>
  `${dir}/${control}.${runId}`;

/** Whether any of `controls` is set over the Run; a file that cannot be read is not set. */
export const controlSet = (
  dir: string,
  runId: string,
  ...controls: ReadonlyArray<string>
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const control of controls)
      if (
        yield* fs.exists(controlPath(dir, control, runId)).pipe(Effect.orElseSucceed(() => false))
      )
        return true;
    return false;
  });

import { Effect } from "effect";
import { LANDED_STATES } from "./board";
import { STOP } from "./controls";
import type { RegistryApi } from "./engine";
import { mrOf, readMrStates } from "./merges";
import { mrIdIn, shell } from "./mr";
import { factsOfView } from "./runs";

// WARNING: A Run stopped after its merge request landed stays stopped.
export const takeUp = (
  opts: { readonly registry: RegistryApi; readonly stateDir: string },
  runId: string,
  recoveryPark?: string,
  healing?: string,
) =>
  Effect.gen(function* () {
    const view = yield* opts.registry.view(runId);
    const run = view === null ? null : factsOfView(opts.stateDir, view);
    const mr = run === null || run.state !== "stopped" ? null : mrOf(run);
    const id = run === null || mr === null ? null : yield* mrIdIn(mr, run.cwd, shell);
    const states =
      id === null
        ? new Map()
        : yield* readMrStates(opts.stateDir).pipe(Effect.orElseSucceed(() => new Map()));
    const state = id === null ? undefined : states.get(id);
    if (state === undefined || !LANDED_STATES.has(state)) {
      return yield* opts.registry.resume(runId, recoveryPark, healing);
    }
    return {
      runId,
      control: STOP,
      set: false,
      left: [],
      applied: false,
      detail: `${runId} was stopped after its merge request merged; there is nothing left to resume`,
    };
  });

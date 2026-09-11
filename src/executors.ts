// Which action kinds this build can actually carry out.
//
// The registry starts empty and each kind is filed by the module that owns the operation,
// so no kind exists here as a stub that does nothing. An unregistered kind is refused at
// confirmation time with `executor_missing` and recorded as skipped, which tells a human
// what this build cannot do rather than letting it succeed at nothing.

import type { BunServices } from "@effect/platform-bun/BunServices";
import type { Effect } from "effect";
import type { Action, ActionKind } from "./evaluator";

/** What running one action reports back. A failure is a result here, never a throw. */
export type ExecutionResult =
  | { readonly state: "applied"; readonly note?: string }
  | { readonly state: "failed"; readonly note: string };

export type Executor<K extends ActionKind> = (
  action: Extract<Action, { kind: K }>,
  /**
   * Who confirmed the proposal this action came out of, as `actorName` writes it. An
   * action that records who asked for it records the confirmation rather than its own
   * request id, which is Collie's and says nothing about who consented.
   */
  by: string,
) => Effect.Effect<ExecutionResult, never, BunServices>;

/** What the registry holds: an action of any kind, narrowed by the kind it was filed under. */
type AnyExecutor = (
  action: Action,
  by: string,
) => Effect.Effect<ExecutionResult, never, BunServices>;

const registry = new Map<ActionKind, AnyExecutor>();

/**
 * Registered by the module that owns the operation, at import time. Registering twice is
 * a programming error rather than a last-one-wins: two owners of one action kind is two
 * answers to "what does confirming this do".
 */
export function registerExecutor<K extends ActionKind>(kind: K, run: Executor<K>): void {
  if (registry.has(kind)) throw new Error(`two executors registered for "${kind}"`);
  registry.set(kind, (action, by) => {
    // SAFETY: `executorFor` is only ever asked for the kind an action carries, so the
    // action reaching this executor is the one variant it was registered for.
    return run(action as Extract<Action, { kind: K }>, by);
  });
}

export function executorFor(kind: ActionKind): AnyExecutor | undefined {
  return registry.get(kind);
}

/** Which kinds this build can carry out, for an envelope that has to say what it skipped. */
export function registeredKinds(): ActionKind[] {
  return [...registry.keys()].sort();
}

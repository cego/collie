// WARNING: an unregistered kind is refused as executor_missing, never succeeded at nothing.
import type { PlatformServices } from "./platform";
import type { Records } from "./records";
import type { Effect } from "effect";
import type { Action, ActionKind } from "./actions";
import type { Actor } from "./proposals";
import type { PluginEnv } from "./env";

export type ExecutionResult =
  | { readonly state: "applied"; readonly note?: string }
  | { readonly state: "failed"; readonly note: string };

export type Executor<K extends ActionKind> = (
  action: Extract<Action, { kind: K }>,
  // WARNING: record the confirmer, not this action's own request id, which says nothing about consent.
  by: Actor,
  env: PluginEnv,
) => Effect.Effect<ExecutionResult, never, PlatformServices | Records>;

type AnyExecutor = (
  action: Action,
  by: Actor,
  env: PluginEnv,
) => Effect.Effect<ExecutionResult, never, PlatformServices | Records>;

const registry = new Map<ActionKind, AnyExecutor>();

// WARNING: registering a kind twice is an error, not last-one-wins.
export function registerExecutor<K extends ActionKind>(kind: K, run: Executor<K>) {
  if (registry.has(kind)) {
    throw new Error(`two executors registered for "${kind}"`);
  }
  registry.set(kind, (action, by, env) => {
    // WARNING: `executorFor` is only ever asked for the kind an action carries, so the action reaching this executor is the one variant it was registered for.
    return run(action as Extract<Action, { kind: K }>, by, env);
  });
}

export function executorFor(kind: ActionKind) {
  return registry.get(kind);
}

export function registeredKinds() {
  return [...registry.keys()].sort();
}

export function resetExecutors() {
  registry.clear();
}

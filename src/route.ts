// Where a start from the Home goes (ADR-0033): the checkout under the Projects root the
// human's words are about. A URL names its own project and is matched to a checkout by
// its remote; anything else is one routing call, and an answer that is not exactly one of
// the checkouts it was shown places nothing.

import { Effect, FileSystem, Path } from "effect";
import type { PluginEnv } from "./env";
import { evaluate, evaluationDeps, type EvaluatorDeps } from "./evaluator";
import { projectFromRemote, projectHere, shell } from "./mr";
import { oneLine } from "./naming";
import { newRequestId } from "./operations";
import { checkoutsUnder } from "./projects";
import { budgetPath, herdOf, reserve, settle } from "./steering";

/** A checkout a Run could be placed in, and the project its remote names. */
export interface Placeable {
  readonly path: string;
  readonly project: string | null;
}

/** Every checkout under the root, with the project its `origin` or `upstream` names. */
export const placeableUnder = Effect.fn("Route.placeableUnder")(function* (root: string) {
  return yield* Effect.forEach(
    yield* checkoutsUnder(root),
    (path) => projectHere(path, shell).pipe(Effect.map((project) => ({ path, project }))),
    { concurrency: 8 },
  );
});

const URL_IN_WORDS = /(?:https?:\/\/|git@)\S+/g;

/**
 * The project a merge request or repository URL in the words names, matched to the one
 * checkout whose remote names the same project; null where no URL does.
 */
export function placedByUrl(words: string, candidates: ReadonlyArray<Placeable>) {
  for (const [url] of words.matchAll(URL_IN_WORDS)) {
    const project = projectFromRemote(url.replace(/\/-\/.*$/, "").replace(/\/+$/, ""));
    if (project === null) continue;
    const found = candidates.find((one) => one.project?.toLowerCase() === project.toLowerCase());
    if (found !== undefined) return found;
  }
  return null;
}

/** Everything the router is shown, and it is all data. */
export function routePack(words: string, candidates: ReadonlyArray<Placeable>): string {
  return [
    "## What the person wants",
    "",
    oneLine(words),
    "",
    "## The checkouts",
    "",
    ...candidates.map((one) => `- ${one.path} (remote: ${one.project ?? "none"})`),
    "",
  ].join("\n");
}

export interface RouterDeps {
  readonly evaluator: EvaluatorDeps;
  /** Where the call is written down as usage, before it is made and after. */
  readonly budget: string;
}

/**
 * What routing may cost, or null where it cannot be asked: no Herd to record the call
 * against, or no frozen prompt to ask with.
 */
export const routerDeps = Effect.fn("Route.routerDeps")(function* (env: PluginEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const herd = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (herd === null) return null;
  const systemPromptFile = path.join(env.pluginRoot, "prompts", "router.md");
  if (!(yield* fs.exists(systemPromptFile).pipe(Effect.orElseSucceed(() => false)))) return null;
  const evaluation = yield* evaluationDeps(env);
  const limits = { maxSeconds: 30, maxOutputBytes: 4 * 1024, model: "haiku", effort: "low" };
  return {
    evaluator: { ...evaluation.evaluator, systemPromptFile, limits },
    budget: yield* budgetPath(env.stateDir, herd),
  } satisfies RouterDeps;
});

/**
 * The one checkout the words are about, or null for several, none, or an evaluator that
 * could not answer inside its schema — never a guess.
 */
export const routed = Effect.fn("Route.routed")(function* (
  deps: RouterDeps | null,
  words: string,
  candidates: ReadonlyArray<Placeable>,
) {
  if (deps === null || candidates.length === 0) return null;
  const callId = yield* newRequestId();
  const asked = yield* Effect.result(
    Effect.gen(function* () {
      yield* reserve(deps.budget, { id: callId, run: null }, deps.evaluator.limits);
      const answer = yield* evaluate(deps.evaluator, "routing", routePack(words, candidates));
      yield* settle(deps.budget, callId, {
        outcome:
          answer.spent.outcome === "ok" && answer.error !== null ? "failed" : answer.spent.outcome,
        usd: answer.spent.usd,
        seconds: answer.spent.seconds,
        bytes: answer.spent.bytes,
      });
      return answer.value;
    }),
  );
  if (asked._tag === "Failure" || asked.success === null || !("answer" in asked.success))
    return null;
  const route = asked.success;
  if (route.answer !== "one" || route.checkouts.length !== 1) return null;
  return candidates.find((one) => one.path === route.checkouts[0]) ?? null;
});

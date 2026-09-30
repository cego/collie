// Where a start from the Home goes (ADR-0033): the checkout under the Projects root the
// human's words are about. A URL names its own project and is matched to a checkout by
// its remote; anything else is one routing call, and an answer that is not exactly one of
// the checkouts it was shown places nothing.

import { Effect } from "effect";
import type { PluginEnv } from "./env";
import { askOnce, budgetedDeps, type BudgetedDeps } from "./evaluator";
import { projectFromRemote, projectHere, shell } from "./mr";
import { oneLine } from "./naming";
import { checkoutsUnder } from "./projects";

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

/** Routing's own prompt and a small, cheap call, as task naming has. */
export const routerDeps = (env: PluginEnv) =>
  budgetedDeps(env, "router.md", {
    maxSeconds: 30,
    maxOutputBytes: 4 * 1024,
    model: "haiku",
    effort: "low",
  });

/**
 * The one checkout the words are about, or null for several, none, or an evaluator that
 * could not answer inside its schema — never a guess.
 */
export const routed = Effect.fn("Route.routed")(function* (
  deps: BudgetedDeps | null,
  words: string,
  candidates: ReadonlyArray<Placeable>,
) {
  if (deps === null || candidates.length === 0) return null;
  const route = yield* askOnce(deps, "routing", routePack(words, candidates));
  if (route === null || !("answer" in route)) return null;
  if (route.answer !== "one" || route.checkouts.length !== 1) return null;
  return candidates.find((one) => one.path === route.checkouts[0]) ?? null;
});

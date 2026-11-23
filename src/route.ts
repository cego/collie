import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect } from "effect";
import { mrRefOf } from "./board-model";
import type { PluginEnv } from "./env";
import { askOnce, budgetedDeps, type BudgetedDeps } from "./evaluator";
import { projectFromRemote, projectHere, shell } from "./mr";
import { oneLine } from "./naming";
import { checkoutsUnder } from "./projects";

export interface Placeable {
  readonly path: string;
  readonly project: string | null;
}

export const placeableUnder = Effect.fn("Route.placeableUnder")(function* (root: string) {
  return yield* Effect.forEach(
    yield* checkoutsUnder(root),
    (path) => projectHere(path, shell).pipe(Effect.map((project) => ({ path, project }))),
    { concurrency: 8 },
  );
});

const URL_IN_WORDS = /(?:https?:\/\/|git@)\S+/g;

export function placedByUrl(words: string, candidates: ReadonlyArray<Placeable>) {
  for (const [url] of pipe_(words, Str.matchAll(URL_IN_WORDS))) {
    const project =
      mrRefOf(url)?.project ??
      projectFromRemote(pipe_(url, Str.replace(/\/-\/.*$/, ""), Str.replace(/\/+$/, "")));
    if (project === null) continue;
    const found = Option.getOrUndefined(
      Arr.findFirst(
        candidates,
        (one) =>
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(one.project), (present) => Str.toLowerCase(present)),
          ) === Str.toLowerCase(project),
      ),
    );
    if (found !== undefined) return found;
  }
  return null;
}

export function routePack(words: string, candidates: ReadonlyArray<Placeable>) {
  return Arr.join(
    [
      "## What the person wants",
      "",
      oneLine(words),
      "",
      "## The checkouts",
      "",
      ...Arr.map(candidates, (one) => `- ${one.path} (remote: ${one.project ?? "none"})`),
      "",
    ],
    "\n",
  );
}

export const routerDeps = (env: PluginEnv) =>
  budgetedDeps(env, "router.md", {
    maxSeconds: 30,
    maxOutputBytes: 4 * 1024,
    model: "haiku",
    effort: "low",
  });

// WARNING: an answer that is not exactly one shown checkout places nothing.
export const routed = Effect.fn("Route.routed")(function* (
  deps: BudgetedDeps | null,
  words: string,
  candidates: ReadonlyArray<Placeable>,
) {
  if (deps === null || candidates.length === 0) return null;
  const route = yield* askOnce(deps, "routing", routePack(words, candidates));
  if (route === null || !("answer" in route)) return null;
  if (route.answer !== "one" || route.checkouts.length !== 1) return null;
  return (
    Option.getOrUndefined(Arr.findFirst(candidates, (one) => one.path === route.checkouts[0])) ??
    null
  );
});

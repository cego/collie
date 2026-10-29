// Which Input carries which strategy, and how a settled Run is read through one.
//
// What a workflow calls its work source is its author's business; what Collie does with
// it is the strategy's. Every reader downstream — branch inference, labels, requirements,
// fan-out, the previous review, the repository a roaming Run is cut from — finds the
// field here rather than looking up a name the shipped workflows happen to use.
//
// Nothing else is imported: this is read from definitions, records, launches and labels
// alike, and a dependency in either direction would put a cycle between two of them.

import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { parseMrTarget } from "./board-model";

/** The name of one of `INPUT_STRATEGIES`; `definitions.ts` is where they are listed. */
export type InputStrategy = string;

/**
 * A launch as everything downstream reads one. `strategies` is what makes it readable:
 * a work source is the field that declared `work-source`, not the field called `plan`.
 */
export interface Settled {
  readonly inputs: Readonly<Record<string, string>>;
  readonly strategies?: Readonly<Record<string, string>> | undefined;
  readonly sources?: Readonly<Record<string, string>> | undefined;
}

/** One Input as it was settled: which field it was, what it holds, and what sort of thing. */
export interface SettledInput {
  readonly name: string;
  readonly value: string;
  readonly kind: string;
  readonly source: string;
}

/** Every field a workflow declared under this strategy, in a stable order. */
export function fieldsWithStrategy(
  inputs: Readonly<Record<string, InputStrategy>>,
  strategy: InputStrategy,
): ReadonlyArray<string> {
  return Arr.filter(Rec.keys(inputs), (name) => inputs[name] === strategy).sort();
}

/** What a review is pointed at, which its value's own shape says. */
export type TargetKind = "mr" | "branch" | "worktree";

/**
 * A diff target's kind is its value's shape; both the picker and a resume read it back.
 * Empty for any other shape, which is a target nobody normalised, never the working tree.
 * An `mr:` is one `parseMrTarget` reads, on either forge, so `mr:group/app` is none.
 */
export function targetKind(value: string): TargetKind | "" {
  if (parseMrTarget(value) !== null) return "mr";
  if (pipe(value, Str.startsWith("branch:"))) return "branch";
  return Str.trim(value) === "worktree" ? "worktree" : "";
}

/**
 * The Input this workflow declared under `strategy`, and null where it declares none or
 * left it empty. Validation allows one field per exclusive strategy, so the first is the
 * only one.
 */
export function settledBy(where: Settled, strategy: InputStrategy): SettledInput | null {
  const name = fieldsWithStrategy(where.strategies ?? {}, strategy)[0];
  if (name === undefined) return null;
  const value =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(where.inputs[name]), (present) => Str.trim(present)),
    ) ?? "";
  if (value === "") return null;
  return {
    name,
    value,
    kind: kindOf(strategy, name, where),
    source: where.sources?.[name] ?? "",
  };
}

/**
 * What sort of thing the value turned out to be. A diff target's is its value's own
 * shape and a `plan-dir` is a plan directory by declaration; a work source's cannot be
 * worked out from the text — telling a plan directory from a review directory means
 * looking at both — so that one is whatever settling it recorded.
 */
function kindOf(strategy: InputStrategy, name: string, where: Settled): string {
  if (strategy === "diff-target") return targetKind(where.inputs[name] ?? "");
  if (strategy === "plan-dir") return "plan-dir";
  return where.inputs[`${name}_kind`] ?? "";
}

/**
 * The work this Run was pointed at, and null for a workflow that takes none. Either
 * strategy names it: `work-source` is any of the five kinds, `plan-dir` only ever a
 * plan directory.
 */
export const workSourceOf = (where: Settled) =>
  settledBy(where, "work-source") ?? settledBy(where, "plan-dir");

/** The Run whose own plan directory this path is, and null where it is none. */
export const planRunOf = (value: string): string | null =>
  /(?:^|\/)runs\/([^/]+)\/plan\/?$/.exec(value)?.[1] ?? null;

/** The change this Run is reviewing, and null for a workflow that reviews nothing. */
export const diffTargetOf = (where: Settled) => settledBy(where, "diff-target");

/** `repository`'s old name, which a module may still hint and a recorded Run still carry. */
const OLD_NAMES = new Map<InputStrategy, InputStrategy>([["gitlab-repository", "repository"]]);

/** A strategy under its current name. */
export const strategyNamed = (strategy: InputStrategy): InputStrategy =>
  OLD_NAMES.get(strategy) ?? strategy;

/** The repository a roaming Run is cut from, and null for the one it was started in. */
export const repositoryOf = (where: Settled) =>
  settledBy(where, "repository") ?? settledBy(where, "gitlab-repository");

/**
 * Strategies only one field may carry, and the launch Input is the one field that carries
 * one of them: what the human's words fill. Two fields claiming to be the work source
 * leaves inference with no answer, and picking one by name is what renaming must not change.
 */
export const EXCLUSIVE_STRATEGIES: ReadonlyArray<InputStrategy> = [
  "goal",
  "work-source",
  "diff-target",
  "repository",
];

/** Hints under their current names, so an old name is held to what its new one is. */
const named = (hints: Readonly<Record<string, InputStrategy>>) =>
  Rec.fromEntries(
    Arr.map(Rec.toEntries(hints), ([name, hint]) => [name, strategyNamed(hint)] as const),
  );

/** Why these inputs do not name exactly one launch Input, or null where they do. */
export function launchInputProblem(
  fields: ReadonlyArray<string>,
  given: Readonly<Record<string, InputStrategy>>,
): string | null {
  if (fields.length === 0) return null;
  const hints = named(given);
  const launch = Arr.filter(Rec.keys(hints), (name) =>
    EXCLUSIVE_STRATEGIES.includes(hints[name] ?? ""),
  ).sort();
  if (launch.length === 0)
    return `no input is the launch Input: hint one of ${Arr.join(
      Arr.map([...fields].sort(), (name) => `"${name}"`),
      ", ",
    )} as ${Arr.join(EXCLUSIVE_STRATEGIES.slice(0, -1), ", ")} or ${EXCLUSIVE_STRATEGIES.at(-1)}`;
  // Two fields of one strategy are that strategy's clash, said once by `exclusiveClashes`.
  if (new Set(Arr.map(launch, (name) => hints[name])).size > 1)
    return `${Arr.join(
      Arr.map(launch, (name) => `"${name}"`),
      " and ",
    )} are both launch Inputs; a workflow has one`;
  return null;
}

/** Every exclusive strategy two fields both claim, one sentence each. */
export function exclusiveClashes(
  given: Readonly<Record<string, InputStrategy>>,
): ReadonlyArray<string> {
  const inputs = named(given);
  return Arr.flatMap(EXCLUSIVE_STRATEGIES, (strategy) => {
    const owners = fieldsWithStrategy(inputs, strategy);
    return owners.length > 1
      ? [
          `${Arr.join(
            Arr.map(owners, (name) => `"${name}"`),
            " and ",
          )} both claim ${strategy}`,
        ]
      : [];
  });
}

/** What an Input of each strategy is, for a refusal to tell a caller that never saw the module. */
const STRATEGY_MEANINGS = new Map<InputStrategy, string>([
  ["goal", "What the Run is for, in the human's own words"],
  [
    "work-source",
    "Where the work is written down: a plan directory, a Linear issue id or URL, or a description",
  ],
  ["plan-dir", "A plan directory, holding SPEC.md and issues/"],
  [
    "diff-target",
    "The change to review: mr:<iid>, mr:<host>/<group/project>!<iid>, mr:github.com/<owner>/<repo>#<n>, a merge request or pull request URL, <owner>/<repo>#<n>, branch:<base>...<head>, or worktree",
  ],
  ["repository", "A GitLab or GitHub repository URL, or the absolute path of a local checkout"],
  [
    "gitlab-repository",
    "A GitLab or GitHub repository URL, or the absolute path of a local checkout",
  ],
  ["flag", "true or false"],
  ["optional", "Anything, or empty"],
]);

export const strategyMeaning = (strategy: InputStrategy): string =>
  STRATEGY_MEANINGS.get(strategy) ?? "";

/** A Run record's Inputs, as every reader above takes them. */
export const recorded = (record: {
  readonly inputs: Readonly<Record<string, string>>;
  readonly input_strategies: Readonly<Record<string, string>>;
  readonly input_sources?: Readonly<Record<string, string>>;
}): Settled => ({
  inputs: record.inputs,
  strategies: record.input_strategies,
  sources: record.input_sources,
});

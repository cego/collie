import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { parseMrTarget } from "./board-model";

export type InputStrategy = string;

export interface Settled {
  readonly inputs: Readonly<Record<string, string>>;
  readonly strategies?: Readonly<Record<string, string>> | undefined;
  readonly sources?: Readonly<Record<string, string>> | undefined;
}

export interface SettledInput {
  readonly name: string;
  readonly value: string;
  readonly kind: string;
  readonly source: string;
}

export function fieldsWithStrategy(
  inputs: Readonly<Record<string, InputStrategy>>,
  strategy: InputStrategy,
) {
  return Arr.filter(Rec.keys(inputs), (name) => inputs[name] === strategy).sort();
}

export type TargetKind = "mr" | "branch" | "worktree";

// WARNING: mr: is read the way parseMrTarget reads it, so mr:group/app is no kind.
export function targetKind(value: string) {
  if (parseMrTarget(value) !== null) {
    return "mr";
  }
  if (pipe(value, Str.startsWith("branch:"))) {
    return "branch";
  }
  return Str.trim(value) === "worktree" ? "worktree" : "";
}

// WARNING: validation allows one field per exclusive strategy, so the first is the only one.
export function settledBy(where: Settled, strategy: InputStrategy) {
  const name = fieldsWithStrategy(where.strategies ?? {}, strategy)[0];
  if (name === undefined) {
    return null;
  }
  const value =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(where.inputs[name]), (present) => Str.trim(present)),
    ) ?? "";
  if (value === "") {
    return null;
  }
  return {
    name,
    value,
    kind: kindOf(strategy, name, where),
    source: where.sources?.[name] ?? "",
  };
}

// WARNING: a work source's kind cannot be told from its text: it is whatever settling recorded.
function kindOf(strategy: InputStrategy, name: string, where: Settled) {
  if (strategy === "diff-target") {
    return targetKind(where.inputs[name] ?? "");
  }
  if (strategy === "plan-dir") {
    return "plan-dir";
  }
  return where.inputs[`${name}_kind`] ?? "";
}

export const workSourceOf = (where: Settled) =>
  settledBy(where, "work-source") ?? settledBy(where, "plan-dir");

export const planRunOf = (value: string) =>
  /(?:^|\/)runs\/([^/]+)\/plan\/?$/.exec(value)?.[1] ?? null;

export const diffTargetOf = (where: Settled) => settledBy(where, "diff-target");

// WARNING: a recorded Run still carries the old name, so it is still read.
const OLD_NAMES = new Map<InputStrategy, InputStrategy>([["gitlab-repository", "repository"]]);

export const strategyNamed = (strategy: InputStrategy) => OLD_NAMES.get(strategy) ?? strategy;

export const repositoryOf = (where: Settled) =>
  settledBy(where, "repository") ?? settledBy(where, "gitlab-repository");

// WARNING: two fields claiming work source leave inference no answer; renaming must not change which one is picked.
export const EXCLUSIVE_STRATEGIES: ReadonlyArray<InputStrategy> = [
  "goal",
  "work-source",
  "diff-target",
  "repository",
];

const named = (hints: Readonly<Record<string, InputStrategy>>) =>
  Rec.fromEntries(
    Arr.map(Rec.toEntries(hints), ([name, hint]) => [name, strategyNamed(hint)] as const),
  );

export function launchInputProblem(
  fields: ReadonlyArray<string>,
  given: Readonly<Record<string, InputStrategy>>,
) {
  if (fields.length === 0) {
    return null;
  }
  const hints = named(given);
  const launch = Arr.filter(Rec.keys(hints), (name) =>
    EXCLUSIVE_STRATEGIES.includes(hints[name] ?? ""),
  ).sort();
  if (launch.length === 0) {
    return `no input is the launch Input: hint one of ${Arr.join(
      Arr.map([...fields].sort(), (name) => `"${name}"`),
      ", ",
    )} as ${Arr.join(EXCLUSIVE_STRATEGIES.slice(0, -1), ", ")} or ${EXCLUSIVE_STRATEGIES.at(-1)}`;
  }
  if (new Set(Arr.map(launch, (name) => hints[name])).size > 1) {
    return `${Arr.join(
      Arr.map(launch, (name) => `"${name}"`),
      " and ",
    )} are both launch Inputs; a workflow has one`;
  }
  return null;
}

export function exclusiveClashes(given: Readonly<Record<string, InputStrategy>>) {
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
  ["reach", "How far the Run goes before it asks; empty asks"],
  ["internal", "Set by the workflow that starts this one, never asked"],
]);

export const strategyMeaning = (strategy: InputStrategy) => STRATEGY_MEANINGS.get(strategy) ?? "";

export const recorded = (record: {
  readonly inputs: Readonly<Record<string, string>>;
  readonly input_strategies: Readonly<Record<string, string>>;
  readonly input_sources?: Readonly<Record<string, string>>;
}) => ({
  inputs: record.inputs,
  strategies: record.input_strategies,
  sources: record.input_sources,
});

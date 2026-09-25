// Which Input carries which strategy, and how a settled Run is read through one.
//
// What a workflow calls its work source is its author's business; what Collie does with
// it is the strategy's. Every reader downstream — branch inference, labels, requirements,
// fan-out, the previous review, the repository a roaming Run is cut from — finds the
// field here rather than looking up a name the shipped workflows happen to use.
//
// Nothing is imported: this is read from definitions, records, launches and labels alike,
// and a dependency in either direction would put a cycle between two of them.

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
  return Object.keys(inputs)
    .filter((name) => inputs[name] === strategy)
    .sort();
}

/** What a review is pointed at, which its value's own shape says. */
export type TargetKind = "mr" | "branch" | "worktree";

/** A diff target's kind is its value's shape; both the picker and a resume read it back. */
export function targetKind(value: string): TargetKind {
  if (value.startsWith("mr:")) return "mr";
  if (value.startsWith("branch:")) return "branch";
  return "worktree";
}

/**
 * The Input this workflow declared under `strategy`, and null where it declares none or
 * left it empty. Validation allows one field per exclusive strategy, so the first is the
 * only one.
 */
export function settledBy(where: Settled, strategy: InputStrategy): SettledInput | null {
  const name = fieldsWithStrategy(where.strategies ?? {}, strategy)[0];
  if (name === undefined) return null;
  const value = where.inputs[name]?.trim() ?? "";
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

/** The change this Run is reviewing, and null for a workflow that reviews nothing. */
export const diffTargetOf = (where: Settled) => settledBy(where, "diff-target");

/** The repository a roaming Run is cut from, and null for the one it was started in. */
export const gitlabRepositoryOf = (where: Settled) => settledBy(where, "gitlab-repository");

/**
 * Strategies only one field may carry. Two fields claiming to be the work source leaves
 * inference with no answer, and picking one by name is what renaming must not change.
 */
export const EXCLUSIVE_STRATEGIES: ReadonlyArray<InputStrategy> = [
  "work-source",
  "diff-target",
  "gitlab-repository",
];

/** Every exclusive strategy two fields both claim, one sentence each. */
export function exclusiveClashes(
  inputs: Readonly<Record<string, InputStrategy>>,
): ReadonlyArray<string> {
  return EXCLUSIVE_STRATEGIES.flatMap((strategy) => {
    const owners = fieldsWithStrategy(inputs, strategy);
    return owners.length > 1
      ? [`${owners.map((name) => `"${name}"`).join(" and ")} both claim ${strategy}`]
      : [];
  });
}

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

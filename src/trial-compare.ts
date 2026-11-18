// `run metrics --compare … --against …`, as the CLI and `collie_run` both ask it: each named
// Run's records read from the host that has it, then compared.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Effect } from "effect";
import { asksRun, type Door } from "./lifecycle";
import { err, type Failure } from "./operations";
import type { PluginEnv } from "./env";
import { compareSets, type Comparison, type Labelled, type Planted } from "./trial-model";

export interface TrialAsk {
  /** `<run>` or `<run>=<case>`. */
  readonly compare: ReadonlyArray<string>;
  readonly against: ReadonlyArray<string>;
  /** `<run>=<review-run>`. */
  readonly audit: ReadonlyArray<string>;
  /** `<case>=<file>:<line>`. */
  readonly plant: ReadonlyArray<string>;
}

const cut = (spec: string, at: Option.Option<number>): readonly [string, string | null] =>
  Option.match(
    Option.filter(at, (index) => index > 0),
    {
      onNone: () => [spec, null],
      onSome: (index) => [Str.slice(0, index)(spec), Str.slice(index + 1)(spec)],
    },
  );
const named = (spec: string) => cut(spec, Str.indexOf("=")(spec));

export const compareRuns = Effect.fn("Trial.compare")(function* (
  env: PluginEnv,
  ask: TrialAsk,
  door?: Door,
) {
  const audits = new Map<string, string>();
  for (const spec of ask.audit) {
    const [run, review] = named(spec);
    if (review === null || review === "")
      return err("invalid_input", `--audit takes <run>=<review-run>, not "${spec}"`);
    audits.set(run, review);
  }
  const planted: Record<string, Planted> = {};
  for (const spec of ask.plant) {
    const [label, at] = named(spec);
    const [file, line] = at === null ? [null, null] : cut(at, Str.lastIndexOf(":")(at));
    if (file === null || line === null || !/^\d+$/.test(line))
      return err("invalid_input", `--plant takes <case>=<file>:<line>, not "${spec}"`);
    planted[label] = { file, line: Number(line) };
  }
  const read = (runId: string) =>
    asksRun(
      env,
      runId,
      (client) =>
        Effect.all({
          view: client.run({ runId }),
          lines: client.runMetrics({ runId }),
          records: client.runTrial({ runId }),
        }),
      door,
    );
  const sideOf = (specs: ReadonlyArray<string>) =>
    Effect.forEach(specs, (spec) =>
      Effect.gen(function* () {
        const [runId, label] = named(spec);
        const got = yield* read(runId);
        if (!got.ok) return got;
        const audit = audits.get(runId);
        const audited = audit === undefined ? null : yield* read(audit);
        if (audited !== null && !audited.ok) return audited;
        const labelled: Labelled = {
          case: label === "" ? null : label,
          run: {
            runId,
            created: got.value.view?.created ?? "",
            lines: got.value.lines,
            records: got.value.records,
            audit: audited === null ? null : audited.value.records,
          },
        };
        return { ok: true as const, value: labelled };
      }),
    );
  const sides = { compare: yield* sideOf(ask.compare), against: yield* sideOf(ask.against) };
  const failed = Arr.findFirst([...sides.compare, ...sides.against], (one) => !one.ok);
  if (failed._tag === "Some" && !failed.value.ok) return failed.value satisfies Failure;
  const labelled = (side: typeof sides.compare) =>
    Arr.flatMap(side, (one) => (one.ok ? [one.value] : []));
  return {
    ok: true as const,
    value: compareSets({
      compare: labelled(sides.compare),
      against: labelled(sides.against),
      planted,
    }) satisfies Comparison,
  };
});

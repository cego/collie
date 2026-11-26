import * as Struct from "effect/Struct";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { Effect } from "effect";
import type { CatalogueEntry } from "./catalogue-model";
import { decodeSubagents, readSubagents } from "./subagents";
import type { ClaudeSubagents } from "./subagents";

export const DEFAULT_MODEL = "default";

export interface HarnessModels {
  defaultModel?: string;
  models: Array<string>;
  modelPattern?: RegExp;
  efforts?: Array<string>;
}

interface ModelCatalogue {
  readonly [name: string]: HarnessModels;
}

export const HARNESS_MODELS: ModelCatalogue = {
  claude: {
    defaultModel: "opus",
    models: ["fable", "opus", "sonnet", "haiku", "opusplan"],
    modelPattern: /^claude-[a-z0-9.-]+$/,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
    modelPattern: /^(?:gpt-?|o)[0-9][a-z0-9.-]*$/,
  },
  pi: {
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  opencode: {
    // WARNING: Empty: provider qualification names the Subscription as well as the model.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
  },
};

export function harnessNames() {
  return Arr.sort(Struct.keys(HARNESS_MODELS), Str.Order);
}

export function knownModel(
  harness: HarnessModels,
  model: string,
  extra: ReadonlyArray<string> = [],
) {
  if (model === DEFAULT_MODEL) {
    return true;
  }
  if (Arr.contains(harness.models, model) || Arr.contains(extra, model)) {
    return true;
  }
  return harness.modelPattern?.test(model) ?? false;
}

export function modelHint(harness: HarnessModels, extra: ReadonlyArray<string> = []) {
  const known = [DEFAULT_MODEL, ...harness.models, ...extra];
  const parts: Array<string> = [];
  if (known.length > 0) {
    parts.push(Arr.join(known, ", "));
  }
  if (harness.modelPattern) {
    parts.push(`or anything matching ${harness.modelPattern.source}`);
  }
  return Arr.join(parts, " ");
}

export interface Preferences {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly claudeSubagents?: ClaudeSubagents;
  readonly upTo?: number;
  readonly otherwise?: ReadonlyArray<Preferences>;
}

export const preferencesIn = (options: {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly claudeSubagents?: ClaudeSubagents | undefined;
}) =>
  Rec.fromEntries(
    Arr.filter(
      Rec.toEntries({
        harness: options.harness,
        model: options.model,
        effort: options.effort,
        claudeSubagents: options.claudeSubagents,
      }),
      ([, value]) => value !== undefined,
    ),
  );

export const preferencesFromOptions = Effect.fn("Harness.preferencesFromOptions")(function* (
  options: Readonly<Record<string, string>>,
) {
  const claudeSubagents =
    options.claudeSubagents === undefined
      ? undefined
      : yield* readSubagents(options.claudeSubagents);
  return preferencesIn({ ...options, claudeSubagents });
});

export const ceilingIn = (options: Preferences) => {
  const ceiling: { -readonly [K in keyof Preferences]: Preferences[K] } = preferencesIn(options);
  if (options.upTo !== undefined) {
    ceiling.upTo = options.upTo;
  }
  if (options.otherwise !== undefined) {
    ceiling.otherwise = options.otherwise;
  }
  return ceiling;
};

export interface AgentChoice {
  readonly harness: string;
  readonly model: string;
  readonly effort: string | null;
  readonly claudeSubagents?: ClaudeSubagents;
}

export interface MachineCatalogue {
  readonly machine: string;
  readonly harnesses: ReadonlyArray<{
    readonly harness: string;
    readonly table: string | null;
    readonly entries: ReadonlyArray<Pick<CatalogueEntry, "model" | "efforts" | "isDefault">>;
  }>;
}

// WARNING: A layer that switches harness keeps nothing chosen below it: a model and effort belong to their harness.
export function foldPreferences(layers: ReadonlyArray<Preferences | undefined>) {
  let harness: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let claudeSubagents: ClaudeSubagents | undefined;
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    if (layer.harness !== undefined && layer.harness !== harness) {
      harness = layer.harness;
      model = undefined;
      effort = undefined;
      claudeSubagents = undefined;
    }
    model = layer.model ?? model;
    effort = layer.effort ?? effort;
    const subagents = layer.claudeSubagents;
    if (subagents !== undefined) {
      claudeSubagents = {
        ...claudeSubagents,
        ...Rec.fromEntries(
          Arr.filter(
            Arr.map(Struct.keys(subagents), (key) => [key, subagents[key]] as const),
            ([, value]) => value !== undefined,
          ),
        ),
      };
    }
  }
  const returned: Pick<Preferences, "harness" | "model" | "effort" | "claudeSubagents"> =
    Rec.fromEntries(
      Arr.filter(
        Rec.toEntries({ harness, model, effort, claudeSubagents }),
        ([, value]) => value !== undefined,
      ),
    );
  return returned;
}

// WARNING: A combination the harness does not take is refused with what it would take, never quietly replaced.
export function resolveChoice(
  layers: ReadonlyArray<Preferences | undefined>,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
  catalogue?: MachineCatalogue,
) {
  const { harness = "", model = DEFAULT_MODEL, effort, claudeSubagents } = foldPreferences(layers);
  const adapter = HARNESS_MODELS[harness];
  if (adapter === undefined) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `no harness called "${harness}" (${Arr.join(harnessNames(), ", ")})`,
    };
    return returned;
  }
  const extra = extraModels[harness] ?? [];
  const reported = Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(catalogue), (current) =>
      Arr.findFirst(current.harnesses, (one) => one.harness === harness),
    ),
  );
  if (catalogue !== undefined && reported === undefined) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `${catalogue.machine} has no ${harness} installed`,
    };
    return returned;
  }
  const selected =
    model === DEFAULT_MODEL
      ? (adapter.defaultModel ??
        Option.getOrUndefined(
          Option.flatMap(Option.fromNullishOr(reported), (current) =>
            Option.map(
              Arr.findFirst(current.entries, (entry) => entry.isDefault === true),
              (entry) => entry.model,
            ),
          ),
        ))
      : model;
  const lists = reported !== undefined && reported.table === null;
  const known = (id: string) =>
    lists
      ? Arr.some(reported.entries, (entry) => entry.model === id) || Arr.contains(extra, id)
      : knownModel(adapter, id, extra);
  const source = reported?.table == null ? "" : `; from Collie's table: ${reported.table}`;
  if (selected !== undefined && !known(selected)) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem:
        catalogue === undefined
          ? `"${model}" is not a model ${harness} takes (${modelHint(adapter, extra)}): name one of those, or the harness it belongs to`
          : `${catalogue.machine}'s ${harness} has no model "${selected}" (${
              lists
                ? Arr.join([...Arr.map(reported.entries, (entry) => entry.model), ...extra], ", ")
                : modelHint(adapter, extra)
            })${source}`,
    };
    return returned;
  }
  const efforts = lists
    ? selected === undefined
      ? [...new Set(Arr.flatMap(reported.entries, (entry) => entry.efforts))]
      : (Option.getOrUndefined(Arr.findFirst(reported.entries, (entry) => entry.model === selected))
          ?.efforts ?? (Arr.contains(extra, selected ?? "") ? adapter.efforts : []))
    : adapter.efforts;
  if (
    effort !== undefined &&
    catalogue !== undefined &&
    !Option.exists(Option.fromNullishOr(efforts), (available) => Arr.contains(available, effort))
  ) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `"${effort}" is not an effort ${catalogue.machine}'s ${harness}/${selected ?? DEFAULT_MODEL} takes (${Option.getOrUndefined(Option.map(Option.fromNullishOr(efforts), (available) => Arr.join(available, ", "))) || "none"})${source}`,
    };
    return returned;
  }
  if (effort !== undefined && efforts === undefined) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `${harness} takes no effort, so "${effort}" cannot be asked of it`,
    };
    return returned;
  }
  if (
    effort !== undefined &&
    !Option.exists(Option.fromNullishOr(efforts), (available) => Arr.contains(available, effort))
  ) {
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `"${effort}" is not an effort ${harness} takes (${Option.getOrUndefined(Option.map(Option.fromNullishOr(efforts), (present) => Arr.join(present, ", ")))})`,
    };
    return returned;
  }
  if (harness === "claude" && claudeSubagents !== undefined) {
    for (const layer of layers) {
      if (layer?.claudeSubagents === undefined) {
        continue;
      }
      const checked = decodeSubagents(layer.claudeSubagents);
      if (checked._tag === "Failure") {
        const returned:
          | { readonly ok: true; readonly choice: AgentChoice }
          | { readonly ok: false; readonly problem: string } = {
          ok: false,
          problem: `claudeSubagents: ${String(checked.failure)}`,
        };
        return returned;
      }
    }
    if (claudeSubagents.forceModel === true && claudeSubagents.model === undefined) {
      const returned:
        | { readonly ok: true; readonly choice: AgentChoice }
        | { readonly ok: false; readonly problem: string } = {
        ok: false,
        problem: "claudeSubagents.forceModel requires a model",
      };
      return returned;
    }
    if (
      claudeSubagents.model !== undefined &&
      !known(
        claudeSubagents.model === DEFAULT_MODEL
          ? (adapter.defaultModel ?? DEFAULT_MODEL)
          : claudeSubagents.model,
      )
    ) {
      const returned:
        | { readonly ok: true; readonly choice: AgentChoice }
        | { readonly ok: false; readonly problem: string } = {
        ok: false,
        problem: `claudeSubagents.model: ${claudeSubagents.model} is not a Claude model`,
      };
      return returned;
    }
    const policy =
      claudeSubagents.model === DEFAULT_MODEL
        ? { ...claudeSubagents, model: adapter.defaultModel ?? DEFAULT_MODEL }
        : claudeSubagents;
    const returned:
      | { readonly ok: true; readonly choice: AgentChoice }
      | { readonly ok: false; readonly problem: string } = {
      ok: true,
      choice: { harness, model, effort: effort ?? null, claudeSubagents: policy },
    };
    return returned;
  }
  const returned:
    | { readonly ok: true; readonly choice: AgentChoice }
    | { readonly ok: false; readonly problem: string } = {
    ok: true,
    choice: { harness, model, effort: effort ?? null },
  };
  return returned;
}

export function foldCeiling(layers: ReadonlyArray<Preferences | undefined>) {
  let harness: string | undefined;
  let ceiling: Preferences = {};
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    if (layer.harness !== undefined && layer.harness !== harness) {
      harness = layer.harness;
      ceiling = {};
    }
    if (layer.upTo !== undefined || layer.otherwise !== undefined) {
      const { upTo, otherwise } = layer;
      ceiling =
        upTo === undefined
          ? { otherwise }
          : otherwise === undefined
            ? { upTo }
            : { upTo, otherwise };
    }
  }
  return ceiling;
}

export function chainEntry(text: string) {
  const at = Option.getOrElse(pipe(text, Str.indexOf("/")), () => -1);
  return at === -1
    ? { harness: text }
    : { harness: pipe(text, Str.slice(0, at)), model: pipe(text, Str.slice(at + 1)) };
}

export type Room = (
  choice: AgentChoice,
  upTo: number | undefined,
) => { readonly room: true } | { readonly room: false; readonly why: string };

export const said = (choice: AgentChoice) =>
  `${choice.harness}/${choice.model}${choice.effort === null ? "" : ` ${choice.effort}`}`;

export interface Chosen {
  readonly choice: AgentChoice;
  readonly from: AgentChoice | null;
  readonly why: string | null;
  readonly skipped: ReadonlyArray<string>;
}

// WARNING: A bad folded or otherwise choice is refused; a bad chain entry is skipped.
export function resolveWithRoom(
  layers: ReadonlyArray<Preferences | undefined>,
  chain: ReadonlyArray<string>,
  room: Room,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
  catalogue?: MachineCatalogue,
) {
  const primary = resolveChoice(layers, extraModels, catalogue);
  if (!primary.ok) {
    const returned:
      | { readonly ok: true; readonly chosen: Chosen }
      | { readonly ok: false; readonly problem: string } = primary;
    return returned;
  }
  const folded = primary.choice;
  const ceiling = foldCeiling(layers);
  const outOfRange = Option.getOrUndefined(
    Arr.findFirst(
      [ceiling.upTo, ...Arr.map(ceiling.otherwise ?? [], ({ upTo }) => upTo)],
      (upTo) => upTo !== undefined && !(upTo >= 1 && upTo <= 100),
    ),
  );
  if (outOfRange !== undefined) {
    const returned:
      | { readonly ok: true; readonly chosen: Chosen }
      | { readonly ok: false; readonly problem: string } = {
      ok: false,
      problem: `upTo is a percentage from 1 to 100, not ${outOfRange}`,
    };
    return returned;
  }
  const base = { ...folded, effort: folded.effort ?? undefined };
  const candidates: Array<{ readonly choice: AgentChoice; readonly upTo?: number }> = [
    { choice: folded, upTo: ceiling.upTo },
  ];
  for (const [at, entry] of (ceiling.otherwise ?? []).entries()) {
    const next = resolveChoice([base, preferencesIn(entry)], extraModels, catalogue);
    if (!next.ok) {
      const returned:
        | { readonly ok: true; readonly chosen: Chosen }
        | { readonly ok: false; readonly problem: string } = {
        ok: false,
        problem: `otherwise entry ${at + 1}: ${next.problem}`,
      };
      return returned;
    }
    candidates.push({ choice: next.choice, upTo: entry.upTo });
  }
  const skipped: Array<string> = [];
  for (const text of chain) {
    const entry = chainEntry(text);
    const harness = entry.harness ?? "";
    const adapter = HARNESS_MODELS[harness];
    const reported = Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(catalogue), (current) =>
        Arr.findFirst(current.harnesses, (one) => one.harness === harness),
      ),
    );
    const model =
      entry.model === undefined || entry.model === DEFAULT_MODEL
        ? (adapter?.defaultModel ??
          Option.getOrUndefined(
            Option.flatMap(Option.fromNullishOr(reported), (current) =>
              Option.map(
                Arr.findFirst(current.entries, (one) => one.isDefault === true),
                (one) => one.model,
              ),
            ),
          ))
        : entry.model;
    const efforts =
      reported?.table === null
        ? model === undefined
          ? Arr.flatMap(reported.entries, (one) => one.efforts)
          : Option.getOrUndefined(Arr.findFirst(reported.entries, (one) => one.model === model))
              ?.efforts
        : adapter?.efforts;
    const takes = Option.exists(Option.fromNullishOr(efforts), (available) =>
      Arr.contains(available, folded.effort ?? ""),
    );
    const next = resolveChoice(
      [
        entry,
        entry.harness === "claude" && folded.harness === "claude"
          ? { claudeSubagents: folded.claudeSubagents }
          : undefined,
        takes && folded.effort !== null ? { effort: folded.effort } : undefined,
      ],
      extraModels,
      catalogue,
    );
    if (next.ok) {
      candidates.push({ choice: next.choice });
    } else {
      skipped.push(`fallback ${text} skipped: ${next.problem}`);
    }
  }
  const whys: Array<string> = [];
  let first: string | null = null;
  for (const { choice, upTo } of candidates) {
    const judged = room(pinned(choice), upTo);
    if (judged.room) {
      const fell = choice !== folded;
      const returned:
        | { readonly ok: true; readonly chosen: Chosen }
        | { readonly ok: false; readonly problem: string } = {
        ok: true,
        chosen: { choice, from: fell ? folded : null, why: fell ? first : null, skipped },
      };
      return returned;
    }
    first ??= judged.why;
    whys.push(`${said(choice)}: ${judged.why}`);
  }
  const returned:
    | { readonly ok: true; readonly chosen: Chosen }
    | { readonly ok: false; readonly problem: string } = {
    ok: true,
    chosen: {
      choice: folded,
      from: null,
      why: `nothing has room; ${Arr.join([...new Set(whys)], "; ")}`,
      skipped,
    },
  };
  return returned;
}

export const pinned = (choice: AgentChoice) =>
  choice.model === DEFAULT_MODEL
    ? { ...choice, model: HARNESS_MODELS[choice.harness]?.defaultModel ?? DEFAULT_MODEL }
    : choice;

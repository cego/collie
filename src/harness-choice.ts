// Harness, model and effort choices shared by the host and Desktop, without host IO.

import { Effect } from "effect";
import type { CatalogueEntry } from "./catalogue-model";
import { decodeSubagents, readSubagents, type ClaudeSubagents } from "./subagents";

/**
 * The harness adapter's pinned default model. Adapters without one still omit the flag.
 */
export const DEFAULT_MODEL = "default";

/** The models and efforts a harness accepts, and its pinned default where it has one. */
export interface HarnessModels {
  /** Pinned model used for `default`; absent keeps the harness's native default. */
  defaultModel?: string;
  models: string[];
  modelPattern?: RegExp;
  efforts?: string[];
}

interface ModelCatalogue {
  readonly [name: string]: HarnessModels;
}

/** The fallback when a harness's own catalogue cannot be read. */
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
    // Provider qualification identifies the Subscription as well as the model.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  opencode: {
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
  },
};

export function harnessNames(): string[] {
  return Object.keys(HARNESS_MODELS).sort();
}

export function knownModel(
  harness: HarnessModels,
  model: string,
  extra: ReadonlyArray<string> = [],
): boolean {
  if (model === DEFAULT_MODEL) return true;
  if (harness.models.includes(model) || extra.includes(model)) return true;
  return harness.modelPattern?.test(model) ?? false;
}

export function modelHint(harness: HarnessModels, extra: ReadonlyArray<string> = []): string {
  const known = [DEFAULT_MODEL, ...harness.models, ...extra];
  const parts: string[] = [];
  if (known.length > 0) parts.push(known.join(", "));
  if (harness.modelPattern) parts.push(`or anything matching ${harness.modelPattern.source}`);
  return parts.join(" ");
}

/** What a layer of configuration or code says about the agent; each field it leaves out is inherited. */
export interface Preferences {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly claudeSubagents?: ClaudeSubagents;
  /** Past this share of its busiest window, 1–100, this agent is not chosen for new work. */
  readonly upTo?: number;
  /** What to try past `upTo` or once Exhausted, in order, before the human's chain. */
  readonly otherwise?: ReadonlyArray<Preferences>;
}

/** The harness, model and effort a set of options names, and nothing else of it. */
export const preferencesIn = (options: {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly claudeSubagents?: ClaudeSubagents | undefined;
}): Preferences =>
  Object.fromEntries(
    Object.entries({
      harness: options.harness,
      model: options.model,
      effort: options.effort,
      claudeSubagents: options.claudeSubagents,
    }).filter(([, value]) => value !== undefined),
  );

/** Agent preferences carried across a child Run's serialized options. */
export const preferencesFromOptions = Effect.fn("Harness.preferencesFromOptions")(function* (
  options: Readonly<Record<string, string>>,
) {
  const claudeSubagents =
    options.claudeSubagents === undefined
      ? undefined
      : yield* readSubagents(options.claudeSubagents);
  return preferencesIn({ ...options, claudeSubagents });
});

/** A preference as code gives it: `preferencesIn`'s fields, with its ceiling where it has one. */
export const ceilingIn = (options: Preferences): Preferences => {
  const ceiling: { -readonly [K in keyof Preferences]: Preferences[K] } = preferencesIn(options);
  if (options.upTo !== undefined) ceiling.upTo = options.upTo;
  if (options.otherwise !== undefined) ceiling.otherwise = options.otherwise;
  return ceiling;
};

/** The agent a piece of work is given, decided before anything starts it. */
export interface AgentChoice {
  readonly harness: string;
  /** `default` is the harness's own pinned or native default. */
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

/**
 * Layers of preferences as one, lowest first. A layer that switches harness keeps nothing
 * chosen below it: a model and an effort are for the harness they were chosen with.
 */
export function foldPreferences(
  layers: ReadonlyArray<Preferences | undefined>,
): Pick<Preferences, "harness" | "model" | "effort" | "claudeSubagents"> {
  let harness: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let claudeSubagents: ClaudeSubagents | undefined;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.harness !== undefined && layer.harness !== harness) {
      harness = layer.harness;
      model = undefined;
      effort = undefined;
      claudeSubagents = undefined;
    }
    model = layer.model ?? model;
    effort = layer.effort ?? effort;
    if (layer.claudeSubagents !== undefined)
      claudeSubagents = {
        ...claudeSubagents,
        ...Object.fromEntries(
          Object.entries(layer.claudeSubagents).filter(([, value]) => value !== undefined),
        ),
      };
  }
  return Object.fromEntries(
    Object.entries({ harness, model, effort, claudeSubagents }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/**
 * Harness, model and effort decided together, lowest layer first, and checked as one.
 * What is left open is the harness's own default; a combination the harness does not take
 * is refused with what it would take, never quietly replaced.
 */
export function resolveChoice(
  layers: ReadonlyArray<Preferences | undefined>,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
  catalogue?: MachineCatalogue,
):
  | { readonly ok: true; readonly choice: AgentChoice }
  | { readonly ok: false; readonly problem: string } {
  const { harness = "", model = DEFAULT_MODEL, effort, claudeSubagents } = foldPreferences(layers);
  const adapter = HARNESS_MODELS[harness];
  if (adapter === undefined) {
    return { ok: false, problem: `no harness called "${harness}" (${harnessNames().join(", ")})` };
  }
  const extra = extraModels[harness] ?? [];
  const reported = catalogue?.harnesses.find((one) => one.harness === harness);
  if (catalogue !== undefined && reported === undefined)
    return { ok: false, problem: `${catalogue.machine} has no ${harness} installed` };
  const selected =
    model === DEFAULT_MODEL
      ? (adapter.defaultModel ?? reported?.entries.find((entry) => entry.isDefault)?.model)
      : model;
  const lists = reported !== undefined && reported.table === null;
  const known = (id: string) =>
    lists
      ? reported.entries.some((entry) => entry.model === id) || extra.includes(id)
      : knownModel(adapter, id, extra);
  const source = reported?.table == null ? "" : `; from Collie's table: ${reported.table}`;
  if (selected !== undefined && !known(selected)) {
    return {
      ok: false,
      problem:
        catalogue === undefined
          ? `"${model}" is not a model ${harness} takes (${modelHint(adapter, extra)}): name one of those, or the harness it belongs to`
          : `${catalogue.machine}'s ${harness} has no model "${selected}" (${
              lists
                ? reported.entries
                    .map((entry) => entry.model)
                    .concat(extra)
                    .join(", ")
                : modelHint(adapter, extra)
            })${source}`,
    };
  }
  const efforts = lists
    ? selected === undefined
      ? [...new Set(reported.entries.flatMap((entry) => entry.efforts))]
      : (reported.entries.find((entry) => entry.model === selected)?.efforts ??
        (extra.includes(selected ?? "") ? adapter.efforts : []))
    : adapter.efforts;
  if (effort !== undefined && catalogue !== undefined && !efforts?.includes(effort))
    return {
      ok: false,
      problem: `"${effort}" is not an effort ${catalogue.machine}'s ${harness}/${selected ?? DEFAULT_MODEL} takes (${efforts?.join(", ") || "none"})${source}`,
    };
  if (effort !== undefined && efforts === undefined) {
    return {
      ok: false,
      problem: `${harness} takes no effort, so "${effort}" cannot be asked of it`,
    };
  }
  if (effort !== undefined && !efforts?.includes(effort)) {
    return {
      ok: false,
      problem: `"${effort}" is not an effort ${harness} takes (${efforts?.join(", ")})`,
    };
  }
  if (harness === "claude" && claudeSubagents !== undefined) {
    for (const layer of layers) {
      if (layer?.claudeSubagents === undefined) continue;
      const checked = decodeSubagents(layer.claudeSubagents);
      if (checked._tag === "Failure")
        return { ok: false, problem: `claudeSubagents: ${String(checked.failure)}` };
    }
    if (claudeSubagents.forceModel === true && claudeSubagents.model === undefined)
      return { ok: false, problem: "claudeSubagents.forceModel requires a model" };
    if (
      claudeSubagents.model !== undefined &&
      !known(
        claudeSubagents.model === DEFAULT_MODEL
          ? (adapter.defaultModel ?? DEFAULT_MODEL)
          : claudeSubagents.model,
      )
    )
      return {
        ok: false,
        problem: `claudeSubagents.model: ${claudeSubagents.model} is not a Claude model`,
      };
    const policy =
      claudeSubagents.model === DEFAULT_MODEL
        ? { ...claudeSubagents, model: adapter.defaultModel ?? DEFAULT_MODEL }
        : claudeSubagents;
    return {
      ok: true,
      choice: { harness, model, effort: effort ?? null, claudeSubagents: policy },
    };
  }
  return { ok: true, choice: { harness, model, effort: effort ?? null } };
}

/**
 * The ceiling layers set, lowest first: the nearest layer that names `upTo` or `otherwise`
 * sets both, and a layer that switches harness clears both.
 */
export function foldCeiling(layers: ReadonlyArray<Preferences | undefined>): Preferences {
  let harness: string | undefined;
  let ceiling: Preferences = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
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

/** A `fallbacks` entry: `harness`, or `harness/model` split at the first `/`. */
export function chainEntry(text: string): Preferences {
  const at = text.indexOf("/");
  return at === -1 ? { harness: text } : { harness: text.slice(0, at), model: text.slice(at + 1) };
}

/** Whether a choice has room under a ceiling, and why not where it has none. */
export type Room = (
  choice: AgentChoice,
  upTo: number | undefined,
) => { readonly room: true } | { readonly room: false; readonly why: string };

export const said = (choice: AgentChoice) =>
  `${choice.harness}/${choice.model}${choice.effort === null ? "" : ` ${choice.effort}`}`;

export interface Chosen {
  readonly choice: AgentChoice;
  /** The folded choice this fell back from, where it did. */
  readonly from: AgentChoice | null;
  readonly why: string | null;
  /** Chain entries that do not resolve, each with why. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * The folded choice, else the first of its `otherwise` entries, else the first of the
 * chain, that has room (ADR-0049 D7). A bad folded or `otherwise` choice is refused; a bad
 * chain entry is skipped. Where nothing has room, the folded choice, saying why.
 */
export function resolveWithRoom(
  layers: ReadonlyArray<Preferences | undefined>,
  chain: ReadonlyArray<string>,
  room: Room,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
  catalogue?: MachineCatalogue,
):
  | { readonly ok: true; readonly chosen: Chosen }
  | { readonly ok: false; readonly problem: string } {
  const primary = resolveChoice(layers, extraModels, catalogue);
  if (!primary.ok) return primary;
  const folded = primary.choice;
  const ceiling = foldCeiling(layers);
  const outOfRange = [ceiling.upTo, ...(ceiling.otherwise ?? []).map(({ upTo }) => upTo)].find(
    (upTo) => upTo !== undefined && !(upTo >= 1 && upTo <= 100),
  );
  if (outOfRange !== undefined)
    return { ok: false, problem: `upTo is a percentage from 1 to 100, not ${outOfRange}` };
  const base = { ...folded, effort: folded.effort ?? undefined };
  const candidates: Array<{ readonly choice: AgentChoice; readonly upTo?: number }> = [
    { choice: folded, upTo: ceiling.upTo },
  ];
  for (const [at, entry] of (ceiling.otherwise ?? []).entries()) {
    const next = resolveChoice([base, preferencesIn(entry)], extraModels, catalogue);
    if (!next.ok) return { ok: false, problem: `otherwise entry ${at + 1}: ${next.problem}` };
    candidates.push({ choice: next.choice, upTo: entry.upTo });
  }
  const skipped: string[] = [];
  for (const text of chain) {
    const entry = chainEntry(text);
    const harness = entry.harness ?? "";
    const adapter = HARNESS_MODELS[harness];
    const reported = catalogue?.harnesses.find((one) => one.harness === harness);
    const model =
      entry.model === undefined || entry.model === DEFAULT_MODEL
        ? (adapter?.defaultModel ?? reported?.entries.find((one) => one.isDefault)?.model)
        : entry.model;
    const efforts =
      reported?.table === null
        ? model === undefined
          ? reported.entries.flatMap((one) => one.efforts)
          : reported.entries.find((one) => one.model === model)?.efforts
        : adapter?.efforts;
    const takes = efforts?.includes(folded.effort ?? "") ?? false;
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
    if (next.ok) candidates.push({ choice: next.choice });
    else skipped.push(`fallback ${text} skipped: ${next.problem}`);
  }
  const whys: string[] = [];
  let first: string | null = null;
  for (const { choice, upTo } of candidates) {
    const judged = room(pinned(choice), upTo);
    if (judged.room) {
      const fell = choice !== folded;
      return {
        ok: true,
        chosen: { choice, from: fell ? folded : null, why: fell ? first : null, skipped },
      };
    }
    first ??= judged.why;
    whys.push(`${said(choice)}: ${judged.why}`);
  }
  return {
    ok: true,
    chosen: {
      choice: folded,
      from: null,
      why: `nothing has room; ${[...new Set(whys)].join("; ")}`,
      skipped,
    },
  };
}

/** The model a choice runs, so `default` is judged as the model it pins. */
export const pinned = (choice: AgentChoice): AgentChoice =>
  choice.model === DEFAULT_MODEL
    ? { ...choice, model: HARNESS_MODELS[choice.harness]?.defaultModel ?? DEFAULT_MODEL }
    : choice;

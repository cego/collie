import { Schema } from "effect";
import { type CatalogueEntry, HarnessCatalogue } from "../../../src/catalogue-model";
import { chainEntry, DEFAULT_MODEL, HARNESS_MODELS } from "../../../src/harness-choice";
import { subscriptionOf } from "../../../src/usage-model";
import { type MachineUsage, usageEntries } from "./usage";
import { HARNESS_NAMES } from "../../../src/settings";
import { harnessName } from "./chat-view";
import { chatSelects, type ChoiceSelect } from "./chat-choices";
import { whenOf } from "./flow";
import type { MachineRow } from "./flock";

export const MachineCatalogue = Schema.Struct({
  profile: Schema.String,
  name: Schema.String,
  catalogues: Schema.Array(HarnessCatalogue),
  problem: Schema.NullOr(Schema.String),
});
export type MachineCatalogue = typeof MachineCatalogue.Type;

export const rememberCatalogues = (
  held: ReadonlyArray<MachineCatalogue>,
  fresh: ReadonlyArray<MachineCatalogue>,
  machines: ReadonlyArray<Pick<MachineRow, "profile" | "name" | "state">>,
): ReadonlyArray<MachineCatalogue> =>
  machines.map(({ profile, name, state }) => {
    const read = fresh.find((one) => one.profile === profile);
    const before = held.find((one) => one.profile === profile);
    return {
      profile,
      name,
      catalogues:
        read?.problem === null ? read.catalogues : (before?.catalogues ?? read?.catalogues ?? []),
      problem:
        state !== "live"
          ? (read?.problem ?? "out of reach")
          : read === undefined
            ? (before?.problem ?? (before === undefined ? "not read yet" : null))
            : read.problem,
    };
  });

interface AgentSettings {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

const count = (n: number, total: number) => `${n} of ${total} Machines`;

export const settingsAgentSelects = (
  readings: ReadonlyArray<MachineCatalogue>,
  profiles: ReadonlyArray<string>,
  set: AgentSettings,
  now = 0,
) => {
  const live = readings.filter(({ profile }) => profiles.includes(profile));
  const merged = HARNESS_NAMES.map((harness) => {
    const sources = live.flatMap(({ profile, name, catalogues }) =>
      catalogues
        .filter((one) => one.harness === harness)
        .map((catalogue) => ({ profile, name, ...catalogue })),
    );
    const models = new Map<
      string,
      {
        entry: CatalogueEntry;
        machines: Set<string>;
        efforts: Map<string, Set<string>>;
        origins: Set<string>;
      }
    >();
    for (const source of sources)
      for (const entry of source.entries) {
        if (entry.hidden && entry.model !== set.model) continue;
        const held = models.get(entry.model) ?? {
          entry,
          machines: new Set<string>(),
          efforts: new Map<string, Set<string>>(),
          origins: new Set<string>(),
        };
        held.machines.add(source.profile);
        held.origins.add(
          entry.from === "added"
            ? `Added by models.${harness}`
            : entry.from === "table"
              ? `From Collie's table: ${source.table}`
              : "Reported by harness",
        );
        for (const effort of entry.efforts) {
          const on = held.efforts.get(effort) ?? new Set<string>();
          on.add(source.profile);
          held.efforts.set(effort, on);
        }
        models.set(entry.model, held);
      }
    return { harness, sources, models };
  });
  const choices = {
    heldOn: set.harness,
    runsOn: null,
    turning: false,
    harnesses: merged.map(({ harness, sources, models }) => ({
      harness,
      label: harnessName(harness),
      installed: sources.length > 0,
      offered: {
        from: "harness" as const,
        unset: {
          harness,
          model: HARNESS_MODELS[harness]?.defaultModel ?? DEFAULT_MODEL,
          effort: null,
        },
        models: [...models].map(([id, { entry, efforts }]) => ({
          id,
          label: entry.label,
          description: entry.description ?? undefined,
          efforts: [...efforts.keys()],
          unsetEffort: entry.defaultEffort,
        })),
      },
    })),
  };
  const selects = chatSelects(
    {
      proactive: true,
      chatHarness: set.harness,
      chatModel: set.model || undefined,
      chatEffort: set.effort || undefined,
    },
    choices,
  );
  const selected = merged.find(({ harness }) => harness === set.harness);
  const model = (id: string) => selected?.models.get(id);
  const modelOptions = selects.model.options.map((option) => {
    if (option.value === "")
      return { ...option, description: "The harness's default model for workflow steps" };
    const entry = model(option.value);
    return entry === undefined
      ? option
      : {
          ...option,
          description: [
            count(entry.machines.size, profiles.length),
            ...entry.origins,
            entry.entry.description,
          ]
            .filter(Boolean)
            .join(" · "),
        };
  });
  const effective =
    set.model && set.model !== DEFAULT_MODEL
      ? set.model
      : (HARNESS_MODELS[set.harness]?.defaultModel ?? DEFAULT_MODEL);
  const picked = model(effective);
  const efforts = picked?.efforts ?? new Map<string, Set<string>>();
  if ((!set.model || set.model === DEFAULT_MODEL) && !HARNESS_MODELS[set.harness]?.defaultModel)
    for (const source of selected?.sources ?? []) {
      const defaultModel = source.entries.find((entry) => entry.isDefault);
      for (const effort of defaultModel?.efforts ??
        source.entries.flatMap((entry) => entry.efforts)) {
        const on = efforts.get(effort) ?? new Set<string>();
        on.add(source.profile);
        efforts.set(effort, on);
      }
    }
  const times = live
    .filter(({ problem }) => problem === null)
    .flatMap(({ catalogues }) => catalogues.map(({ at }) => at))
    .sort();
  if (times.length === 0)
    times.push(...live.flatMap(({ catalogues }) => catalogues.map(({ at }) => at)).sort());
  const problems = live.flatMap(({ name, problem, catalogues }) => {
    if (catalogues.length === 0)
      return [
        problem === null
          ? `${name}: no harnesses reported`
          : `${name} not read yet${problem === "not read yet" ? "" : `: ${problem}`}`,
      ];
    const at = catalogues.map(({ at }) => at).sort()[0]!;
    return problem === null ? [] : [`${name}'s at ${whenOf(at, now)}: ${problem}`];
  });
  const effort: ChoiceSelect = {
    ...selects.effort,
    disabled: efforts.size === 0,
    label: efforts.size === 0 ? "No effort listed" : set.effort || "Default · the harness decides",
    name: `Effort: ${set.effort || "default"}`,
    options: [
      { value: "", label: "Default · the harness decides" },
      ...[...efforts].map(([value, on]) => ({
        value,
        label: value,
        description: count(on.size, profiles.length),
      })),
    ],
    note: "The efforts reported for this model across the Flock",
  };
  return {
    harness: {
      ...selects.harness,
      options: selects.harness.options.map((option) => ({
        ...option,
        description: count(
          merged.find(({ harness }) => harness === option.value)?.sources.length ?? 0,
          profiles.length,
        ),
        ...(option.disabled && { description: "Not reported on any Machine" }),
      })),
      note: "The harness for every step unless it names its own",
    },
    model: {
      ...selects.model,
      label:
        picked === undefined
          ? selects.model.label
          : `${selects.model.label} · ${count(picked.machines.size, profiles.length)}`,
      options: modelOptions,
      note: "Models and availability reported across the Flock",
      warning:
        set.model && set.model !== DEFAULT_MODEL && model(set.model) === undefined
          ? `${set.model} is not reported on any Machine. A step on it would not start unless it is added under Advanced.`
          : undefined,
    },
    effort,
    lead: [
      times.length === 0
        ? "No harness catalogues available yet."
        : `Catalogues read ${whenOf(times[0]!, now)} · ${live.filter(({ catalogues }) => catalogues.length > 0).length} of ${profiles.length} Machines read`,
      ...problems,
    ].join(" · "),
  };
};

const fallbackValues = (value: string) =>
  value
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);

export const agentSettingChanges = (
  catalogues: ReadonlyArray<MachineCatalogue>,
  profiles: ReadonlyArray<string>,
  current: AgentSettings,
  key: "harness" | "model" | "effort",
  value: string,
): ReadonlyArray<{ readonly key: string; readonly value: string }> => {
  let next = {
    ...current,
    model: current.model ?? DEFAULT_MODEL,
    effort: current.effort ?? "",
    [key]: value,
  };
  if (key === "harness" && value !== current.harness)
    next = { ...next, model: DEFAULT_MODEL, effort: "" };
  const select = settingsAgentSelects(catalogues, profiles, next);
  if (key === "model" && !select.effort.options.some((option) => option.value === next.effort))
    next = { ...next, effort: "" };
  return [
    { key: "harness", value: next.harness },
    { key: "model", value: next.model },
    { key: "effort", value: next.effort },
  ];
};

export const changeFallbacks = (
  value: string,
  action:
    | { readonly add: string }
    | { readonly at: number; readonly move: "up" | "down" | "remove" },
): string => {
  const values = fallbackValues(value);
  if ("add" in action) {
    if (action.add !== "" && !values.includes(action.add)) values.push(action.add);
  } else if (action.at >= 0 && action.at < values.length) {
    if (action.move === "remove") values.splice(action.at, 1);
    else {
      const to = action.at + (action.move === "up" ? -1 : 1);
      if (to >= 0 && to < values.length)
        [values[action.at], values[to]] = [values[to]!, values[action.at]!];
    }
  }
  return values.join(", ");
};

export const fallbackList = (
  value: string,
  catalogues: ReadonlyArray<MachineCatalogue>,
  profiles: ReadonlyArray<string>,
  usage: ReadonlyArray<MachineUsage>,
  now: number,
) => {
  const values = fallbackValues(value);
  const entries = values.map((value) => {
    const choice = chainEntry(value);
    const subscription = subscriptionOf({
      harness: choice.harness!,
      model: choice.model ?? DEFAULT_MODEL,
    });
    return {
      value,
      usage:
        subscription === null
          ? []
          : usageEntries(
              usage.map((machine) => ({
                ...machine,
                readings: machine.readings.filter(
                  (reading) => reading.subscription === subscription,
                ),
              })),
              profiles,
              now,
            ),
    };
  });
  const options = HARNESS_NAMES.flatMap((harness) => {
    const selects = settingsAgentSelects(catalogues, profiles, { harness });
    if (selects.harness.options.find(({ value }) => value === harness)?.disabled) return [];
    return [
      { value: harness, label: `${harnessName(harness)} · its default model` },
      ...selects.model.options
        .filter(({ value }) => value !== "")
        .map((option) => ({
          ...option,
          value: `${harness}/${option.value}`,
          label: `${harnessName(harness)} · ${option.label}`,
        })),
    ];
  }).filter((option) => !values.includes(option.value));
  const add: ChoiceSelect = {
    value: "",
    label: "Add a fallback…",
    name: "Add a fallback",
    disabled: false,
    options: [{ value: "", label: "Add a fallback…" }, ...options],
    note: "The first with usage left runs the step. A typed entry is harness/model.",
  };
  return { entries, add };
};

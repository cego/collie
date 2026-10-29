// A Machine's Harness catalogue: what each installed harness says it can run, decoded from
// that harness's own output, and Collie's table where a harness cannot be read. No IO.

import { Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS } from "./harness-choice";

export const CatalogueEntry = Schema.Struct({
  model: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  /** The harness's own report, Collie's table, or the `models.<harness>` setting. */
  from: Schema.Literals(["harness", "table", "added"]),
});
export type CatalogueEntry = typeof CatalogueEntry.Type;

export const HarnessCatalogue = Schema.Struct({
  harness: Schema.String,
  at: Schema.String,
  /** Why the harness could not be read, its entries then Collie's table; null where it was. */
  table: Schema.NullOr(Schema.String),
  entries: Schema.Array(CatalogueEntry),
});
export type HarnessCatalogue = typeof HarnessCatalogue.Type;

const entry = (
  model: string,
  label: string,
  rest: Partial<Omit<CatalogueEntry, "model" | "label">> = {},
): CatalogueEntry => ({
  model,
  label,
  description: null,
  efforts: [],
  defaultEffort: null,
  hidden: false,
  from: "harness",
  ...rest,
});

/** What Claude Code's `supportedModels()` answers. */
export const ClaudeModels = Schema.Array(
  Schema.Struct({
    value: Schema.String,
    displayName: Schema.String,
    description: Schema.String,
    supportsEffort: Schema.optionalKey(Schema.Boolean),
    supportedEffortLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
export type ClaudeModels = typeof ClaudeModels.Type;

/** Claude Code's models, but its `default`, which is Collie's own `default`. */
export const claudeEntries = (models: ClaudeModels): ReadonlyArray<CatalogueEntry> =>
  models
    .filter(({ value }) => value !== DEFAULT_MODEL)
    .map((model) =>
      entry(model.value, model.displayName, {
        description: model.description === "" ? null : model.description,
        efforts: model.supportsEffort === true ? (model.supportedEffortLevels ?? []) : [],
      }),
    );

/** The result of Codex's app-server `model/list`, asked with `includeHidden`. */
export const CodexModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      displayName: Schema.String,
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      hidden: Schema.Boolean,
      supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
      defaultReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type CodexModelList = typeof CodexModelList.Type;

export const codexEntries = ({ data }: CodexModelList): ReadonlyArray<CatalogueEntry> =>
  data.map((model) =>
    entry(model.id, model.displayName, {
      description: model.description ?? null,
      efforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort),
      defaultEffort: model.defaultReasoningEffort ?? null,
      hidden: model.hidden,
    }),
  );

/** `pi --list-models`: a table whose thinking column says only yes or no. */
export const piEntries = (text: string): ReadonlyArray<CatalogueEntry> | null => {
  const [header, ...rows] = text.split("\n").map((line) => line.trim().split(/\s+/));
  const column = (name: string) => header?.indexOf(name) ?? -1;
  const [provider, model, thinking] = [column("provider"), column("model"), column("thinking")];
  if (provider < 0 || model < 0 || thinking < 0) return null;
  return rows
    .filter((row) => row.length === header!.length)
    .map((row) =>
      entry(`${row[provider]}/${row[model]}`, row[model]!, {
        efforts: row[thinking] === "yes" ? (HARNESS_MODELS.pi?.efforts ?? []) : [],
      }),
    );
};

/** `opencode models`: one `provider/model` a line, and nothing about effort. */
export const opencodeEntries = (text: string): ReadonlyArray<CatalogueEntry> | null => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const ids = lines.filter((line) => /^[^\s/]+\/\S+$/.test(line));
  if (ids.length === 0 || ids.length < lines.length) return null;
  return ids.map((id) => entry(id, id.slice(id.indexOf("/") + 1)));
};

/** Collie's own table for a harness, where the harness itself could not be read. */
export const tableEntries = (harness: string): ReadonlyArray<CatalogueEntry> => {
  const table = HARNESS_MODELS[harness];
  return (table?.models ?? []).map((model) =>
    entry(model, model, { efforts: table?.efforts ?? [], from: "table" }),
  );
};

/** The `models.<harness>` setting's models a harness did not list, after the ones it did. */
export const withAdded = (
  catalogue: HarnessCatalogue,
  added: ReadonlyArray<string>,
): HarnessCatalogue => {
  const listed = new Set(catalogue.entries.map((one) => one.model));
  const fresh = added.filter((model) => !listed.has(model));
  if (fresh.length === 0) return catalogue;
  const efforts = HARNESS_MODELS[catalogue.harness]?.efforts ?? [];
  return {
    ...catalogue,
    entries: [
      ...catalogue.entries,
      ...fresh.map((model) => entry(model, model, { efforts, from: "added" })),
    ],
  };
};

const PAD = 10;

/** One line per entry, after its harness's line where that is on Collie's table; `only` keeps one. */
export function modelsLines(catalogues: ReadonlyArray<HarnessCatalogue>, only?: string): string {
  const kept = catalogues.filter((one) => only === undefined || one.harness === only);
  if (kept.length === 0) return `${only ?? "No harness"} is not installed on this Machine.`;
  return kept
    .flatMap(({ harness, table, entries }) => [
      ...(table === null ? [] : [`${harness.padEnd(PAD)}from Collie's table: ${table}`]),
      ...entries.map((entry) => {
        const marks = [
          entry.efforts.length === 0 ? null : `efforts ${entry.efforts.join(", ")}`,
          entry.defaultEffort === null ? null : `default ${entry.defaultEffort}`,
          entry.hidden ? "hidden" : null,
          entry.from === "added" ? `added in models.${harness}` : null,
        ].filter((mark) => mark !== null);
        const named = entry.label === entry.model ? entry.model : `${entry.model} (${entry.label})`;
        return `${harness.padEnd(PAD)}${[named, ...marks].join(" · ")}`;
      }),
    ])
    .join("\n");
}

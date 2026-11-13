// The Heal: one Run the host starts for a park its own recovery could not clear, judged by
// the parked Run's facts (ADR-draft-a-run-recovers-where-it-parks D7–D9).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schema } from "effect";
import type { PluginEnv } from "./env";
import { configValue, readConfig } from "./config";
import { HealFinding, type Metric } from "./metrics";
import { PARK_CAUSES, type ParkCause } from "./park-cause";
import { LAYERS } from "./definitions-model";
import { ProducerReport } from "./narrative-model";

export const HEALS_PER_RUN = 3;

/** What a Heal hands back: a claim the host reads for words, never for its judgement. */
const HealSaid = {
  ...ProducerReport.fields,
  diagnosis: Schema.String,
  actions: Schema.Array(Schema.String),
  finding: HealFinding,
};
export const HealOutput = Schema.Union([
  Schema.Struct({
    ...HealSaid,
    result: Schema.Literal("resumed"),
    needs_person: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...HealSaid,
    result: Schema.Literal("escalate"),
    /** Why only a person can move the Run. */
    needs_person: Schema.String,
  }),
]);
export type HealOutput = typeof HealOutput.Type;

/** Every Heal a Run has had, by its claim. */
const healsIn = (recoveries: ReadonlyArray<Metric>) =>
  Arr.filter(recoveries, (line) => line.action === "healed" && line.outcome !== "skipped");

/**
 * Why a needs-you park goes straight to a person rather than to a Heal, or null where a Heal
 * takes it. Whether a healer is declared is the caller's, asked last, as it reads modules.
 */
export const passedOver = (facts: {
  readonly cause: ParkCause;
  readonly isHeal: boolean;
  readonly on: boolean;
  /** It has a Hold, a Stop or an open Decision. */
  readonly waitsOnYou: boolean;
  readonly recoveries: ReadonlyArray<Metric>;
}): string | null => {
  const entry = PARK_CAUSES[facts.cause];
  if (entry.kind === "needs-you" && entry.neverHeals === true)
    return "only a person can act on its cause";
  if (facts.isHeal) return "it is itself a Heal";
  if (!facts.on) return "recovery.heal is off";
  if (facts.waitsOnYou) return "it already waits on you";
  if (healsIn(facts.recoveries).length >= HEALS_PER_RUN) return `it has had ${HEALS_PER_RUN} Heals`;
  return null;
};

/** The definition that declares itself the healer for `project`, nearest layer first. */
// Imported when asked: discovery loads modules through the engine, which imports this.
export const healerFor = (env: Pick<PluginEnv, "pluginRoot" | "userDir">, project: string) =>
  Effect.promise(() => import("./discovery")).pipe(
    Effect.flatMap(({ savedModules }) =>
      savedModules({ pluginRoot: env.pluginRoot, userDir: env.userDir, cwd: project }),
    ),
    Effect.map((saved) =>
      Option.getOrNull(
        Arr.findFirst(LAYERS, (layer) =>
          Arr.findFirst(saved.entries, (entry) => entry.heals === true && entry.layer === layer),
        ),
      ),
    ),
  );

export const healRequest = (run: string, park: string) => `heal:${run}:${park}`;

export const healOn = (userDir: string) =>
  readConfig(userDir).pipe(Effect.map((raw) => configValue(raw, "recovery.heal") !== false));

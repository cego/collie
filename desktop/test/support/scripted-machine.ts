import { Schema } from "effect";
import {
  Herd,
  type OfferView,
  RunDetail,
  type Startable,
  TaskView,
} from "../../../src/board-model";

export const ScriptedMachine = Schema.Struct({
  installation: Schema.String,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  /** Each Run's details, by its id. */
  details: Schema.optionalKey(Schema.Record(Schema.String, RunDetail)),
  /** What each reference of a Run's fetches, keyed `<run id> <ref>`: text, or bytes as base64. */
  files: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Struct({ base64: Schema.String })]),
    ),
  ),
});
export type ScriptedMachine = typeof ScriptedMachine.Type;

/** What a scripted host refuses, so a refusal reaches the human in the host's words. */
export const REFUSED_RUN = "r-refused";

export const OFFERS: ReadonlyArray<OfferView> = [
  {
    id: "build-it",
    title: "Build these tickets",
    workflow: "implement",
    arguments: null,
    kind: "action",
    primary: true,
    unavailable: null,
  },
  {
    id: "look-again",
    title: "Look again",
    workflow: "review",
    arguments: { properties: { note: { type: "string" } }, required: ["note"] },
    kind: "action",
    primary: false,
    unavailable: null,
  },
];

export const STARTABLE: ReadonlyArray<Startable> = [
  {
    id: "plan",
    title: "Plan",
    description: "Write a plan",
    inputs: [{ name: "request", required: true, schema: { type: "string" } }],
  },
];

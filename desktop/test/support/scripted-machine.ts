import { Schema } from "effect";
import { Herd, type OfferView, type Startable, TaskView } from "../../../src/board-model";

export const ScriptedMachine = Schema.Struct({
  installation: Schema.String,
  build: Schema.optionalKey(Schema.String),
  development: Schema.optionalKey(Schema.String),
  protocol: Schema.optionalKey(Schema.Int),
  /** What `collie doctor` finds failing, where the Machine answers it at all. */
  failing: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, detail: Schema.String, fix: Schema.String })),
  ),
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
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

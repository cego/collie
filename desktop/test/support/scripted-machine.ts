import { Schema } from "effect";
import {
  Herd,
  NewsBatch,
  type OfferView,
  type Startable,
  TaskView,
} from "../../../src/board-model";

export const ScriptedMachine = Schema.Struct({
  installation: Schema.String,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  /** Its News for whoever asks, every Herd's alike; a conversation settling an item takes it off. */
  news: Schema.optionalKey(NewsBatch.fields.items),
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

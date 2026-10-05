import { Schema } from "effect";
import { Herd, TaskView } from "../../../src/board-model";

/** What a scripted host says about its Machine. */
export const ScriptedMachine = Schema.Struct({
  installation: Schema.String,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
});
export type ScriptedMachine = typeof ScriptedMachine.Type;

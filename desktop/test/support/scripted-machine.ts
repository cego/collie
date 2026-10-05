import { Schema } from "effect";
import { Herd, TaskView } from "../../../src/board-model";

export const ScriptedMachine = Schema.Struct({
  installation: Schema.String,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
});
export type ScriptedMachine = typeof ScriptedMachine.Type;

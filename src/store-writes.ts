import { Context } from "effect";

export class StoreWrites extends Context.Service<
  StoreWrites,
  (runs: ReadonlyArray<string>) => void
>()("collie/StoreWrites") {}

export class TaskWrites extends Context.Service<
  TaskWrites,
  (tasks: ReadonlyArray<string>) => void
>()("collie/TaskWrites") {}

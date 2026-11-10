import { Context } from "effect";

/** Told the Runs each write to `host.db` names. */
export class StoreWrites extends Context.Service<
  StoreWrites,
  (runs: ReadonlyArray<string>) => void
>()("collie/StoreWrites") {}

/** Told the Tasks each write to `host.db` names. */
export class TaskWrites extends Context.Service<
  TaskWrites,
  (tasks: ReadonlyArray<string>) => void
>()("collie/TaskWrites") {}

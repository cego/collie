import { Context } from "effect";

/** Told the Runs each write to `host.db` names. */
export class StoreWrites extends Context.Service<
  StoreWrites,
  (runs: ReadonlyArray<string>) => void
>()("collie/StoreWrites") {}

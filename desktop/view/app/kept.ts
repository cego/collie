// The records the view keeps subscribed after it shows them (`shared/kept-records.ts` says
// which), so one opened again has its frame as it mounts.

import { AsyncResult, defaultRegistry } from "@effect/atom-vue";
import { Clock, Effect, Option } from "effect";
import { keptHolder } from "../../src/shared/kept-records";
import { runDetailAtom } from "./flock";

export const kept = keptHolder(
  (key, sized) =>
    defaultRegistry.subscribe(
      runDetailAtom(key),
      (result) =>
        Option.map(
          Option.flatMap(AsyncResult.value(result), ({ value }) => value),
          ({ bytes }) => sized(bytes),
        ),
      { immediate: true },
    ),
  () => Effect.runSync(Clock.currentTimeMillis),
  (ms, then) => void Effect.runFork(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(then)))),
);

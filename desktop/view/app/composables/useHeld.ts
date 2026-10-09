// What a page reads of a subscription: its last value, kept through trouble, and the trouble.

import { AsyncResult, Atom, useAtomValue } from "@effect/atom-vue";
import { Clock, Option, Schedule, Stream } from "effect";
import type { Held } from "../../../src/shared/retrying";

export const useHeld = <A, E>(atom: () => Atom.Atom<AsyncResult.AsyncResult<Held<A>, E>>) => {
  const result = useAtomValue(atom);
  const held = computed(() => AsyncResult.getOrElse(result.value, () => null));
  return {
    /** Undefined until the first value. */
    value: computed(() =>
      held.value === null ? undefined : Option.getOrUndefined(held.value.value),
    ),
    trouble: computed(() => held.value?.trouble ?? null),
  };
};

/** Now, again every second, for a countdown to the next try. */
export const secondsAtom = Atom.make(
  Stream.fromEffect(Clock.currentTimeMillis).pipe(
    Stream.concat(
      Stream.fromSchedule(Schedule.spaced("1 second")).pipe(
        Stream.mapEffect(() => Clock.currentTimeMillis),
      ),
    ),
  ),
);

// The board the view draws: the Flock's Tasks in their sections and the header sentence,
// counted against a clock that moves even while no board message arrives.

import { AsyncResult, Atom, useAtomValue } from "@effect/atom-vue";
import { Cause, Clock, Schedule, Stream } from "effect";
import {
  foldWaiting,
  headerSentence,
  type Section,
  sectionsOf,
  type TaskView,
} from "../../../../src/board-model";
import { type Card, EMPTY_FLOCK, flockCards } from "../../../src/shared/flock";
import { flockAtom } from "../flock";

/** Now, again every minute: a week's fold and the header's count of it age with it. */
const clockAtom = Atom.make(
  Stream.fromEffect(Clock.currentTimeMillis).pipe(
    Stream.concat(
      Stream.fromSchedule(Schedule.spaced("1 minute")).pipe(
        Stream.mapEffect(() => Clock.currentTimeMillis),
      ),
    ),
  ),
).pipe(Atom.keepAlive);

export const useFlock = () => {
  const flock = useAtomValue(() => flockAtom);
  const clock = useAtomValue(() => clockAtom);
  const now = computed(() => AsyncResult.getOrElse(clock.value, () => 0));
  const known = computed(() => AsyncResult.getOrElse(flock.value, () => EMPTY_FLOCK));
  const board = computed(() => flockCards(known.value));
  const tasks = computed(() => board.value.tasks);
  const cards = (some: ReadonlyArray<TaskView>) => some.map(board.value.cardOf);
  const found = computed(() => sectionsOf(tasks.value, ""));
  return {
    connecting: computed(() => AsyncResult.isInitial(flock.value)),
    failure: computed(() =>
      AsyncResult.isFailure(flock.value) ? Cause.pretty(flock.value.cause) : null,
    ),
    lost: computed(() => [...known.value.lost]),
    tasks,
    sections: computed(
      () =>
        ({
          "needs-you": cards(found.value.needs),
          waiting: cards(found.value.waiting),
          working: cards(found.value.working),
          finished: cards(found.value.finished),
        }) satisfies Record<Section, ReadonlyArray<Card>>,
    ),
    header: computed(() => headerSentence(tasks.value, now.value)),
    waiting: computed(() => {
      const { recent, older } = foldWaiting(found.value.waiting, now.value);
      return { recent: cards(recent), older: cards(older) };
    }),
  };
};

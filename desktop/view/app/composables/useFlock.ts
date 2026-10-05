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
import { EMPTY_FLOCK, flockCards, type PlacedTask } from "../../../src/shared/flock";
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
  const told = computed(() => AsyncResult.getOrElse(flock.value, () => EMPTY_FLOCK));
  const board = computed(() => flockCards(told.value));
  const tasks = computed(() => board.value.tasks);
  const placed = (some: ReadonlyArray<TaskView>) => some.map(board.value.placedOf);
  const sections = computed(() => sectionsOf(tasks.value, ""));
  return {
    connecting: computed(() => AsyncResult.isInitial(flock.value)),
    failure: computed(() =>
      AsyncResult.isFailure(flock.value) ? Cause.pretty(flock.value.cause) : null,
    ),
    lost: computed(() => [...told.value.lost]),
    machines: computed(() => board.value.machines),
    developments: computed(() => board.value.developments),
    notices: computed(() => told.value.notices),
    tasks,
    sections: computed(
      () =>
        ({
          "needs-you": placed(sections.value.needs),
          waiting: placed(sections.value.waiting),
          working: placed(sections.value.working),
          finished: placed(sections.value.finished),
        }) satisfies Record<Section, ReadonlyArray<PlacedTask>>,
    ),
    header: computed(() => headerSentence(tasks.value, now.value)),
    waiting: computed(() => {
      const { recent, older } = foldWaiting(sections.value.waiting, now.value);
      return { recent: placed(recent), older: placed(older) };
    }),
  };
};

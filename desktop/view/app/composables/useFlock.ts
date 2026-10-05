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
import { flockTasks } from "../../../src/shared/flock";
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
  const tasks = computed(() =>
    AsyncResult.isSuccess(flock.value) ? flockTasks(flock.value.value) : [],
  );
  const sections = computed(() => {
    const found = sectionsOf(tasks.value, "");
    return {
      "needs-you": found.needs,
      waiting: found.waiting,
      working: found.working,
      finished: found.finished,
    } satisfies Record<Section, ReadonlyArray<TaskView>>;
  });
  return {
    connecting: computed(() => AsyncResult.isInitial(flock.value)),
    failure: computed(() =>
      AsyncResult.isFailure(flock.value) ? Cause.pretty(flock.value.cause) : null,
    ),
    tasks,
    sections,
    header: computed(() => headerSentence(tasks.value, now.value)),
    waiting: computed(() => foldWaiting(sections.value.waiting, now.value)),
  };
};

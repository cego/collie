// The board the view draws: the Flock's Tasks in their sections and the header sentence,
// counted against a clock that moves even while no board message arrives.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { AsyncResult, Atom, useAtomValue } from "@effect/atom-vue";
import { Clock, Schedule, Stream } from "effect";
import {
  foldFinished,
  foldWaiting,
  headerSentence,
  type Section,
  sectionsOf,
  type TaskView,
} from "../../../../src/board-model";
import {
  EMPTY_FLOCK,
  flockCards,
  machineRows,
  notLiveOf,
  type PlacedTask,
} from "../../../src/shared/flock";
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
  const flock = useHeld(() => flockAtom);
  const clock = useAtomValue(() => clockAtom);
  const now = computed(() => AsyncResult.getOrElse(clock.value, () => 0));
  const told = computed(() => flock.value.value ?? EMPTY_FLOCK);
  const board = computed(() => flockCards(told.value));
  const tasks = computed(() => board.value.tasks);
  const placed = (some: ReadonlyArray<TaskView>) => Arr.map(some, board.value.placedOf);
  const sections = computed(() => sectionsOf(tasks.value, ""));
  return {
    connecting: computed(() => flock.value.value === undefined && flock.trouble.value === null),
    /** Why the board's own stream failed, while it tries again. */
    trouble: flock.trouble,
    lost: computed(() => [...told.value.lost]),
    notLive: (installation: string) => notLiveOf(told.value, installation),
    protocolOf: (installation: string) => told.value.machines.get(installation)?.protocol ?? null,
    machines: computed(() => board.value.machines),
    notices: computed(() => told.value.notices),
    /** Now, as of the last minute. */
    now,
    rows: computed(() => machineRows(told.value)),
    onboarding: computed(() => told.value.onboarding),
    tasks,
    everyTask: computed(() => placed(tasks.value)),
    placedBy: (key: string) =>
      Option.getOrUndefined(Arr.findFirst(placed(tasks.value), (one) => one.key === key)),
    placedAt: (machine: string, task: string) =>
      Option.getOrUndefined(
        Arr.findFirst(
          placed(tasks.value),
          (one) => one.machine === machine && one.task.id === task,
        ),
      ),
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
    finished: computed(() => {
      const { unseen, seen } = foldFinished(sections.value.finished);
      return { unseen: placed(unseen), seen: placed(seen) };
    }),
    waiting: computed(() => {
      const { recent, older } = foldWaiting(sections.value.waiting, now.value);
      return { recent: placed(recent), older: placed(older) };
    }),
  };
};

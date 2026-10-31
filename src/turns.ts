// A scheduler whose turns of the event loop are bounded in time, so a request waiting behind
// background work is read at the next turn (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model, D6).

import * as Arr from "effect/Array";
import * as Scheduler from "effect/Scheduler";

/** How long one turn runs fibers before the event loop takes its I/O. */
export const TURN_MS = 8;

// oxlint-disable-next-line no-restricted-globals -- A scheduler runs outside every fiber, so no Clock.
const now = () => performance.now();

class TurnDispatcher implements Scheduler.SchedulerDispatcher {
  private buckets: Array<[priority: number, tasks: Array<() => void>]> = [];
  /** What the last turn drained and had no time left for, in the order it was drained. */
  private left: Array<() => void> = [];
  private at = 0;
  private running = false;

  scheduleTask(task: () => void, priority: number) {
    const buckets = this.buckets;
    let index = 0;
    while (index < buckets.length && buckets[index]![0] < priority) index++;
    if (buckets[index]?.[0] === priority) buckets[index]![1].push(task);
    else buckets.splice(index, 0, [priority, [task]]);
    this.wake();
  }

  flush() {
    while (this.left.length > 0 || this.buckets.length > 0) this.turn(Infinity);
  }

  private wake() {
    if (this.running) return;
    this.running = true;
    setImmediate(() => {
      this.running = false;
      this.turn(TURN_MS);
    });
  }

  private turn(budget: number) {
    const tasks = [...this.left, ...Arr.flatMap(this.buckets, ([, tasks]) => tasks)];
    this.left = [];
    this.buckets = [];
    const started = now();
    for (this.at = 0; this.at < tasks.length;) {
      tasks[this.at++]!();
      if (now() - started > budget) break;
    }
    if (this.at < tasks.length) {
      this.left = tasks.slice(this.at);
      this.wake();
    }
  }
}

/**
 * Effect's own scheduler, with one dispatcher for every fiber whose turns end once they have
 * run for `TURN_MS`, and a fiber yielding once it has run that long at a stretch.
 */
export class TurnScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async" as const;
  private readonly inner = new Scheduler.MixedScheduler();
  private readonly dispatcher = new TurnDispatcher();
  /** When the running fiber's stretch began: one fiber runs at a time. */
  private since = 0;
  shouldYield(fiber: Parameters<Scheduler.Scheduler["shouldYield"]>[0]) {
    if (fiber.currentOpCount === 1) {
      this.since = now();
      return false;
    }
    if (this.inner.shouldYield(fiber)) return true;
    return (fiber.currentOpCount & 63) === 0 && now() - this.since > TURN_MS;
  }
  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return this.dispatcher;
  }
}

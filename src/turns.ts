// A scheduler whose turns of the event loop are bounded in time, so a request waiting behind
// background work is read at the next turn (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model, D6).

import * as Arr from "effect/Array";
import * as Scheduler from "effect/Scheduler";

/** How long one turn runs fibers before the event loop takes its I/O. */
export const TURN_MS = 8;

// oxlint-disable-next-line no-restricted-globals -- A scheduler runs outside every fiber, so no Clock.
const now = () => performance.now();

class TurnDispatcher implements Scheduler.SchedulerDispatcher {
  /** Tasks of fibers serving interactive work, run before any other. */
  readonly front: Array<() => void> = [];
  private buckets: Array<[priority: number, tasks: Array<() => void>]> = [];
  /** What the last turn drained and had no time left for, in the order it was drained. */
  private left: Array<() => void> = [];
  private at = 0;
  private running = false;

  constructor(private readonly first: () => boolean) {}

  scheduleTask(task: () => void, priority: number) {
    if (this.first()) {
      this.front.push(task);
      return this.wake();
    }
    const buckets = this.buckets;
    let index = 0;
    while (index < buckets.length && buckets[index]![0] < priority) index++;
    if (buckets[index]?.[0] === priority) buckets[index]![1].push(task);
    else buckets.splice(index, 0, [priority, [task]]);
    this.wake();
  }

  flush() {
    while (this.front.length > 0 || this.left.length > 0 || this.buckets.length > 0)
      this.turn(Infinity);
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
    const over = () => now() - started > budget;
    for (this.at = 0; ;) {
      while (this.front.length > 0 && !over()) this.front.shift()!();
      if (this.at >= tasks.length || over()) break;
      tasks[this.at++]!();
    }
    this.left = tasks.slice(this.at);
    if (this.front.length > 0 || this.left.length > 0 || this.buckets.length > 0) this.wake();
  }
}

/**
 * Effect's own scheduler, with one dispatcher for every fiber whose turns end once they have
 * run for `TURN_MS`, and a fiber yielding once it has run that long at a stretch.
 */
export class TurnScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async" as const;
  private readonly inner = new Scheduler.MixedScheduler();
  private readonly dispatcher: TurnDispatcher;
  /** `first` says whether the running fiber's tasks go before every other's. */
  constructor(private readonly first: () => boolean = () => false) {
    this.dispatcher = new TurnDispatcher(first);
  }
  /** When the running fiber's stretch began: one fiber runs at a time. */
  private since = 0;
  shouldYield(fiber: Parameters<Scheduler.Scheduler["shouldYield"]>[0]) {
    // Automatic resumptions run their saved instruction before consulting the scheduler.
    if (fiber.currentOpCount <= 3) this.since = now();
    if (fiber.currentOpCount === 1) return false;
    if (this.inner.shouldYield(fiber)) return true;
    if ((fiber.currentOpCount & 63) !== 0) return false;
    // Background work steps aside while a served fiber's task waits.
    return now() - this.since > TURN_MS || (this.dispatcher.front.length > 0 && !this.first());
  }
  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return this.dispatcher;
  }
}

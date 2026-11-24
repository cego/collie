import * as Arr from "effect/Array";
import * as Scheduler from "effect/Scheduler";

export const TURN_MS = 8;

// oxlint-disable-next-line no-restricted-globals -- A scheduler runs outside every fiber, so no Clock.
const platformNow = () => performance.now();

class TurnDispatcher implements Scheduler.SchedulerDispatcher {
  readonly front: Array<() => void> = [];
  private buckets: Array<[priority: number, tasks: Array<() => void>]> = [];
  private left: Array<() => void> = [];
  private at = 0;
  private running = false;

  constructor(
    private readonly first: () => boolean,
    private readonly now: () => number,
  ) {}

  scheduleTask(task: () => void, priority: number) {
    if (this.first()) {
      this.front.push(task);
      return this.wake();
    }
    const buckets = this.buckets;
    let index = 0;
    while (index < buckets.length && buckets[index]![0] < priority) {
      index++;
    }
    if (buckets[index]?.[0] === priority) {
      buckets[index]![1].push(task);
    } else {
      buckets.splice(index, 0, [priority, [task]]);
    }
    this.wake();
  }

  flush() {
    while (this.front.length > 0 || this.left.length > 0 || this.buckets.length > 0) {
      this.turn(Infinity);
    }
  }

  private wake() {
    if (this.running) {
      return;
    }
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
    const started = this.now();
    const over = () => this.now() - started > budget;
    for (this.at = 0; ;) {
      while (this.front.length > 0 && !over()) {
        this.front.shift()!();
      }
      if (this.at >= tasks.length || over()) {
        break;
      }
      tasks[this.at++]!();
    }
    this.left = tasks.slice(this.at);
    if (this.front.length > 0 || this.left.length > 0 || this.buckets.length > 0) {
      this.wake();
    }
  }
}

export class TurnScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async" as const;
  private readonly inner = new Scheduler.MixedScheduler();
  private readonly dispatcher: TurnDispatcher;
  constructor(
    private readonly first: () => boolean = () => false,
    private readonly now: () => number = platformNow,
  ) {
    this.dispatcher = new TurnDispatcher(first, now);
  }
  private since = 0;
  private readonly yielded = new WeakSet<object>();
  shouldYield(fiber: Parameters<Scheduler.Scheduler["shouldYield"]>[0]) {
    if (this.yielded.delete(fiber) || fiber.currentOpCount === 1) {
      this.since = this.now();
    }
    if (fiber.currentOpCount === 1) {
      return false;
    }
    const over = this.inner.shouldYield(fiber) || this.overTurn(fiber);
    if (over) {
      this.yielded.add(fiber);
    }
    return over;
  }
  private overTurn(fiber: Parameters<Scheduler.Scheduler["shouldYield"]>[0]) {
    if ((fiber.currentOpCount & 63) !== 0) {
      return false;
    }
    return this.now() - this.since > TURN_MS || (this.dispatcher.front.length > 0 && !this.first());
  }
  makeDispatcher() {
    return this.dispatcher;
  }
}

import type { Cause } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { Doors } from "../../desktop/src/bun/machine";
import type { RecordUnchanged, RunDetail, RunRevision } from "../../src/board-model";

export type Answer = RunDetail | RecordUnchanged | null;
export interface Asked {
  readonly runId: string;
  readonly held?: RunRevision;
}

export const revision = (seq: number) => ({ epoch: "e-1", seq });

// WARNING: the tests read only a record's title and revision.
export const frame = (title: string) => ({ title }) as RunDetail;
export const frameAt = (title: string, seq: number) => ({
  ...frame(title),
  revision: revision(seq),
});

export const unchanged: (seq: number) => RecordUnchanged = (seq) => ({
  _tag: "Unchanged",
  revision: revision(seq),
});

export const recordDoor = (asked: Array<Asked>) =>
  Effect.sync(() => {
    const queues = new Map<string, Queue.Queue<Answer, Cause.Done>>();
    const queueOf = (runId: string) =>
      Effect.suspend(() => {
        const was = queues.get(runId);
        if (was !== undefined) return Effect.succeed(was);
        return Effect.tap(Queue.unbounded<Answer, Cause.Done>(), (made) =>
          Effect.sync(() => queues.set(runId, made)),
        );
      });
    const runDetail = (payload: Asked) =>
      Stream.unwrap(
        Effect.map(queueOf(payload.runId), (queue) => {
          asked.push(payload);
          return Stream.fromQueue(queue);
        }),
      );
    const door = {
      // WARNING: the tests call only `runDetail`, whose stream answers as the host's does.
      record: { runDetail: runDetail as Doors["record"]["runDetail"] } as Doors["record"],
    };
    return {
      door,
      offer: (runId: string, answer: Answer) =>
        Effect.flatMap(queueOf(runId), (queue) => Queue.offer(queue, answer)),
      close: Effect.suspend(() =>
        Effect.forEach([...queues.values()], (queue) => Queue.end(queue), { discard: true }),
      ),
    };
  });

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Effect } from "effect";
import { Command } from "effect/cli";
import type { AgentFallback } from "../board-model";
import { usageFallbacks, usageReadings } from "../lifecycle";
import { agoMs, epochMs } from "../time";
import { current, resetPhrase, type UsageReading } from "../usage-model";
import { answering, cliDoor } from "./shared";

export function usageLines(readings: ReadonlyArray<UsageReading>, now: number) {
  return Arr.join(
    Arr.flatMap(readings, (reading) => {
      const who = Arr.join(
        Arr.filter([reading.plan, reading.accountLabel], (part) => part !== null),
        " · ",
      );
      const head = `${pipe_(reading.subscription, Str.padEnd(8))}${who === "" ? "" : `${who}  `}`;
      const windows = Arr.map(reading.windows, (read) => {
        const window = current(read, now);
        const used = `${window.label} ${Math.round(window.usedPercent)}%${window.reached ? " (reached)" : ""}`;
        return window.resetsAt === null
          ? `${head}${used}`
          : `${head}${used} · ${resetPhrase(window.resetsAt, now)}`;
      });
      const age = `read ${agoMs(epochMs(reading.at), now)} from ${reading.source}`;
      const said =
        reading.problem === null
          ? age
          : windows.length === 0
            ? reading.problem
            : `${reading.problem}; ${age}`;
      return [...windows, `${pipe_(reading.subscription, Str.padEnd(8))}${said}`];
    }),
    "\n",
  );
}

export const fallbackLines = (fallbacks: ReadonlyArray<AgentFallback>) =>
  Arr.map(
    fallbacks,
    (one) => `fallback ${one.agent} of ${one.run} is on ${one.on}, falls back to ${one.next}`,
  );

export const usage = Command.make("usage", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const door = yield* cliDoor(env);
      const read = yield* usageReadings(env, door);
      if (!read.ok) return read;
      const fallbacks = yield* usageFallbacks(env, door);
      if (!fallbacks.ok) return fallbacks;
      const now = yield* Clock.currentTimeMillis;
      return {
        ok: true as const,
        data: { readings: read.value, fallbacks: fallbacks.value },
        human: Arr.join([usageLines(read.value, now), ...fallbackLines(fallbacks.value)], "\n"),
      };
    }),
  ),
).pipe(Command.withDescription("How much of each Claude and ChatGPT subscription is used"));

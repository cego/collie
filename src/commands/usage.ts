// `collie usage`: how much of each Subscription this Machine's logins have used, per
// window, as its host last read it (ADR-0049).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Effect } from "effect";
import { Command } from "effect/cli";
import { usageReadings } from "../lifecycle";
import { agoMs, epochMs } from "../time";
import { current, resetPhrase, type UsageReading } from "../usage-model";
import { answering, cliDoor } from "./shared";

/** One line per window, then the reading's age and source, or its problem. */
export function usageLines(readings: ReadonlyArray<UsageReading>, now: number): string {
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

export const usage = Command.make("usage", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const read = yield* usageReadings(env, yield* cliDoor(env));
      if (!read.ok) return read;
      const now = yield* Clock.currentTimeMillis;
      return {
        ok: true as const,
        data: { readings: read.value },
        human: usageLines(read.value, now),
      };
    }),
  ),
).pipe(Command.withDescription("How much of each Claude and ChatGPT subscription is used"));

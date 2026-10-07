// `collie cleanup`: what the host's sweep would remove now, and `--apply` to sweep now
// (ADR-0045). No confirmation: the host does the same on its own every ten minutes.

import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { CleanupReport } from "../board-model";
import { humanBytes } from "../cleanup";
import { mutation } from "../envelope";
import { cleanupListing, sweepNow } from "../lifecycle";
import { answering, cliDoor, requestIdFlag } from "./shared";

/** One line per item, then the kept, then the total. */
const lines = (report: CleanupReport, applied: boolean) =>
  [
    ...report.remove.map((item) =>
      [
        applied ? "removed" : "would remove",
        item.kind,
        item.target,
        humanBytes(item.bytes),
        item.reason,
      ].join("\t"),
    ),
    ...report.keep.map((item) => ["kept", item.kind, item.target, item.reason].join("\t")),
    `${applied ? "freed" : "would free"}\t${humanBytes(report.bytes)}`,
  ].join("\n");

export const cleanup = Command.make(
  "cleanup",
  {
    apply: Flag.Boolean("apply").pipe(
      Flag.withDescription("Sweep now; without it this only lists what a sweep would remove"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ apply, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const door = yield* cliDoor(env);
        if (!apply) {
          const listed = yield* cleanupListing(env, door);
          if (!listed.ok) return listed;
          return { ok: true as const, data: listed.value, human: lines(listed.value, false) };
        }
        return yield* mutation(env, "cleanup", requestId, (request) =>
          Effect.gen(function* () {
            const swept = yield* sweepNow(env, { door, request });
            if (!swept.ok) return swept;
            return { ok: true as const, data: swept.value, human: lines(swept.value, true) };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("What Collie made and would remove now; --apply sweeps now"));

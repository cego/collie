// `collie cleanup`: what the host's sweep would remove now, and `--apply` to sweep now
// (ADR-0045). No confirmation: the host does the same on its own every ten minutes.

import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { cleanupLines } from "../cleanup";
import { mutation } from "../envelope";
import { cleanupListing, sweepNow } from "../lifecycle";
import { answering, cliDoor, requestIdFlag } from "./shared";

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
          return {
            ok: true as const,
            data: listed.value,
            human: cleanupLines(listed.value, false),
          };
        }
        return yield* mutation(env, "cleanup", requestId, (request) =>
          Effect.gen(function* () {
            const swept = yield* sweepNow(env, { door, request });
            if (!swept.ok) return swept;
            return { ok: true as const, data: swept.value, human: cleanupLines(swept.value, true) };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("What Collie made and would remove now; --apply sweeps now"));

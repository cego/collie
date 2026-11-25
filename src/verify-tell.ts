import { Effect } from "effect";
import type { CollectingApi } from "./collecting";
import type { AgentStatus } from "./herdr";
import type { Verification } from "./verify-model";

export interface VerifyTell<Settled, Steered, R> {
  readonly collecting: CollectingApi;
  readonly status: (agent: string) => Effect.Effect<AgentStatus, Settled, R>;
  readonly steer: (tell: {
    readonly run: string;
    readonly agent: string;
    readonly request: string;
    readonly text: string;
  }) => Effect.Effect<void, Steered, R>;
}

// WARNING: an agent working when its verify ends is not told: it has the result in its own turn.
export const tellVerifyEnded: <Settled, Steered, R>(
  tell: VerifyTell<Settled, Steered, R>,
  asker: { readonly run: string; readonly agent: string },
  verified: Verification,
) => Effect.Effect<void, Settled | Steered, R> = (tell, asker, verified) =>
  Effect.gen(function* () {
    if (!(yield* tell.collecting.has(asker.run, asker.agent))) {
      return;
    }
    const now = yield* tell.status(asker.agent);
    if (now === "working" || now === "blocked") {
      return;
    }
    yield* tell.steer({
      ...asker,
      request: `verify-${verified.id}`,
      text: `Your collie verify "${verified.name}" ended: ${verified.result} (exit ${verified.exit}) at ${verified.end.head_sha}. Its log: ${verified.log ?? "none kept"}`,
    });
  });

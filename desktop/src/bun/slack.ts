import { Effect } from "effect";
import { slackApi } from "../../../src/slack";
import type { Keyring } from "./credentials";

export const saveSlackConnection = (
  text: string,
  keyring: Keyring,
  give: (
    token: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly failed: string | null }>>,
  api = slackApi,
) =>
  Effect.gen(function* () {
    const token = text.trim();
    if (!/^xoxb-[^\s]+$/.test(token))
      return yield* Effect.fail("Paste the xoxb- Bot User OAuth Token from OAuth & Permissions");
    const identity = yield* api(token).auth();
    yield* keyring.store("slack-token", "Collie's Slack bot token", token);
    return { identity, given: yield* give(token) };
  });

export const disconnectSlackConnection = (
  keyring: Keyring,
  give: (
    token: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly failed: string | null }>>,
) =>
  Effect.gen(function* () {
    // Keep the removal pending for Machines that reconnect later.
    yield* keyring.store("slack-token", "Slack disconnected", "");
    return yield* give("");
  });

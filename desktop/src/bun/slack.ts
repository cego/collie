import { Effect } from "effect";
import type { Keyring } from "./credentials";

/** Forgets an older Collie's bot token here and on every Machine, those that connect later too. */
export const retireSlackBot = (
  keyring: Keyring,
  give: (
    text: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly failed: string | null }>>,
) => keyring.store("slack-token", "Slack bot token removed", "").pipe(Effect.andThen(give("")));

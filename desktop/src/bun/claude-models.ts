// Claude Code's own list of models, from the human's install and login, read without a turn.

import { Effect, Stream } from "effect";
import type { ListedModel } from "../shared/chat-choices";
import { CHILD_CWD, childEnv } from "./login-env";

/** A row of Claude Code's list, as much of the Agent SDK's `ModelInfo` as the chat reads. */
export interface ModelRow {
  readonly value: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
}

/** What the reader needs of the Agent SDK's `query`. */
export type ModelsQuery = (params: {
  readonly prompt: AsyncIterable<never>;
  readonly options: ReturnType<typeof listOptions>;
}) => {
  readonly supportedModels: () => Promise<ReadonlyArray<ModelRow>>;
  readonly close: () => void;
};

/** A session that loads none of the human's setup, may use no tool and is kept nowhere. */
const listOptions = (claude: string | null) => ({
  cwd: CHILD_CWD,
  settingSources: [],
  tools: [],
  persistSession: false,
  env: childEnv(),
  pathToClaudeCodeExecutable: claude ?? undefined,
});

const listedOf = (row: ModelRow): ListedModel => ({
  id: row.value,
  label: row.displayName,
  description: row.description,
  efforts: row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? []),
});

/** Claude Code's list, or why it could not be read; `claude` is its executable, or null for the SDK's own. */
export const readClaudeModels = (query: ModelsQuery, claude: string | null) =>
  Effect.acquireUseRelease(
    Effect.try({
      // A prompt that never sends a message, so no turn starts.
      try: () =>
        query({ prompt: Stream.toAsyncIterable(Stream.never), options: listOptions(claude) }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }),
    (session) =>
      Effect.tryPromise({
        try: () => session.supportedModels(),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }),
    (session) => Effect.sync(() => session.close()),
  ).pipe(Effect.map((rows) => rows.map(listedOf)));

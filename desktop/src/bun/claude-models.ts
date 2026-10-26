import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect } from "effect";
import { DEFAULT_MODEL } from "../../../src/harness-choice";
import type { Offered } from "../shared/chat-choices";
import type { FlockSettings } from "../shared/flock-settings";
import type { UserMessage } from "./claude-driver";
import { childEnv, which } from "./login-env";
import { chatChoice } from "./settings";

export type ListedModel = Omit<Offered, "unsetEffort">;

const modelOptions = (cwd: string, claude: string | null) => ({
  cwd,
  settingSources: [],
  tools: [],
  mcpServers: {},
  strictMcpConfig: true,
  persistSession: false,
  env: childEnv(),
  pathToClaudeCodeExecutable: claude ?? undefined,
});

export type ModelQuery = (params: {
  readonly prompt: AsyncIterable<UserMessage>;
  readonly options: ReturnType<typeof modelOptions>;
}) => {
  readonly supportedModels: () => Promise<ReadonlyArray<ModelInfo>>;
  readonly close: () => void;
};

export const readClaudeModels = (
  query: ModelQuery,
  flock: FlockSettings,
  dir: string,
  claude = which("claude"),
) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          query({
            prompt: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  Effect.runPromise(
                    Deferred.await(closed).pipe(
                      Effect.as({ done: true as const, value: undefined }),
                    ),
                  ),
              }),
            },
            options: modelOptions(dir, claude),
          }),
        catch: String,
      }),
      (session) => Effect.tryPromise({ try: () => session.supportedModels(), catch: String }),
      (session) => Effect.sync(() => session.close()),
    ).pipe(
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.map((models): ReadonlyArray<ListedModel> =>
        models
          .filter(
            ({ value }) =>
              value !== DEFAULT_MODEL &&
              chatChoice({ proactive: true, chatHarness: "claude", chatModel: value }, flock).ok,
          )
          .map(({ value, displayName, description, supportsEffort, supportedEffortLevels }) => ({
            id: value,
            label: displayName,
            description,
            efforts: supportsEffort === false ? [] : (supportedEffortLevels ?? []),
          })),
      ),
    );
  });

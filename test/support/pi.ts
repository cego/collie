import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, type Schema } from "effect";

export interface PiTool {
  readonly name: string;
  readonly execute: (
    id: string,
    params: Schema.Json,
    signal: undefined,
    onUpdate: undefined,
    ctx: { readonly sessionManager: { readonly getSessionId: () => string } },
  ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
}
interface Pi {
  readonly registerTool: (tool: PiTool) => void;
  readonly sendMessage: () => void;
  readonly on: () => void;
  readonly events: { readonly on: () => void };
}
interface Extension {
  readonly default: (pi: Pi) => void;
}

export const piTools = (file: string) =>
  Effect.promise(() => {
    const returned: Promise<Extension> = import(file);
    return returned;
  }).pipe(
    Effect.map((loaded) => {
      const tools: Array<PiTool> = [];
      loaded.default({
        registerTool: (tool) => {
          tools.push(tool);
        },
        sendMessage: () => undefined,
        on: () => undefined,
        events: { on: () => undefined },
      });
      return tools;
    }),
  );

export const askWith = (
  tools: ReadonlyArray<PiTool>,
  id: string,
  questions: Schema.Json,
  session: string,
) =>
  Effect.promise(() =>
    Option.getOrThrow(Arr.findFirst(tools, (tool) => tool.name === "ask_user_question")).execute(
      id,
      { questions },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => session } },
    ),
  ).pipe(
    Effect.map((result) =>
      Arr.join(
        Arr.map(result.content, (part) => part.text),
        "\n",
      ),
    ),
  );

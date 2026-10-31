// A pi extension Collie generated, loaded as pi loads one, with a pi that only collects tools.

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
/** The part of pi's extension API Collie's extension calls. */
interface Pi {
  readonly registerTool: (tool: PiTool) => void;
  readonly sendMessage: () => void;
  readonly on: () => void;
  readonly events: { readonly on: () => void };
}
interface Extension {
  readonly default: (pi: Pi) => void;
}

/** The tools the extension at `file` registers. */
export const piTools = (file: string) =>
  Effect.promise((): Promise<Extension> => import(file)).pipe(
    Effect.map((loaded) => {
      const tools: PiTool[] = [];
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

/** pi's question tool among `tools`, called as pi calls it; what it told the agent. */
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

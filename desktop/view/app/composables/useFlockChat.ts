// The Flock chat as the view holds it: TanStack AI's Vue client, connected to the main
// process's `say` stream. The session keeps the conversation, so a turn sends only the
// human's newest message.

import { AtomRegistry, injectRegistry } from "@effect/atom-vue";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import { useChat } from "@tanstack/ai-vue";
import { Effect, Stream } from "effect";
import { isString } from "../../../../src/schema";
import { FlockClient } from "../flock";

const lastSaid = (messages: ReadonlyArray<UIMessage | ModelMessage>) => {
  const last = messages.findLast((message) => message.role === "user");
  if (last === undefined) return "";
  if ("parts" in last)
    return last.parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("\n");
  return isString(last.content) ? last.content : "";
};

export const useFlockChat = () => {
  const registry = injectRegistry();
  const turn = (text: string) =>
    Stream.unwrap(
      AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
        Effect.map((context) =>
          Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("say", { text })))).pipe(
            Stream.provideContext(context),
          ),
        ),
      ),
    );
  return useChat({
    connection: {
      // SAFETY: AG-UI's event types are string enums whose values are these events' `type`s.
      connect: (messages) =>
        Stream.toAsyncIterable(turn(lastSaid(messages))) as AsyncIterable<StreamChunk>,
    },
  });
};

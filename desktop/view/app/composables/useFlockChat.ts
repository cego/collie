// The Flock chat as the view holds it: TanStack AI's Vue client, connected to the main
// process's `say` stream. The session keeps the conversation, so a turn sends only the
// human's newest message and the card it goes with; the window is filled from the
// session's transcript when it opens and when another conversation becomes current.

import { AtomRegistry, injectRegistry, useAtomSet } from "@effect/atom-vue";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";
import { useChat } from "@tanstack/ai-vue";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { isString } from "../../../../src/schema";
import { About, type Answers } from "../../../src/shared/chat-view";
import { FlockClient } from "../flock";

const answerAtom = FlockClient.mutation("answer");
const transcriptAtom = FlockClient.mutation("transcript");
const conversationsAtom = FlockClient.mutation("conversations");
const reopenAtom = FlockClient.mutation("reopen");
const popOutAtom = FlockClient.mutation("popOut");
const popInAtom = FlockClient.mutation("popIn");

const decodeAbout = Schema.decodeUnknownOption(About);

const lastSaid = (messages: ReadonlyArray<UIMessage | ModelMessage>) => {
  const last = messages.findLast((message) => message.role === "user");
  if (last === undefined) return "";
  if ("parts" in last)
    return last.parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("\n");
  return isString(last.content) ? last.content : "";
};

export const useFlockChat = () => {
  const registry = injectRegistry();
  const turn = (text: string, about: About | null) =>
    Stream.unwrap(
      AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
        Effect.map((context) =>
          Stream.unwrap(
            FlockClient.use((client) => Effect.succeed(client("say", { text, about }))),
          ).pipe(Stream.provideContext(context)),
        ),
      ),
    );
  const chat = useChat({
    connection: {
      // SAFETY: AG-UI's event types are string enums whose values are these events' `type`s.
      connect: (messages, body) =>
        Stream.toAsyncIterable(
          turn(lastSaid(messages), Option.getOrNull(decodeAbout(body?.about))),
        ) as AsyncIterable<StreamChunk>,
    },
  });
  const answer = useAtomSet(() => answerAtom, { mode: "promiseExit" });
  const transcript = useAtomSet(() => transcriptAtom, { mode: "promiseExit" });
  const conversations = useAtomSet(() => conversationsAtom, { mode: "promiseExit" });
  const reopen = useAtomSet(() => reopenAtom, { mode: "promiseExit" });

  const reload = () =>
    transcript({ payload: undefined }).then((exit) => {
      if (Exit.isSuccess(exit))
        chat.setMessages(exit.value.map((message) => ({ ...message, parts: [...message.parts] })));
    });

  return {
    ...chat,
    /** Sends a message with the card it is about, queued while a turn is under way. */
    say: (text: string, about: About | null) => chat.sendMessage(text, { body: { about } }),
    answer: (toolCallId: string, answers: Answers) => answer({ payload: { toolCallId, answers } }),
    reload,
    conversations: () =>
      conversations({ payload: undefined }).then((exit) =>
        Exit.isSuccess(exit) ? exit.value : null,
      ),
    /** Makes that conversation current, or a fresh one, and shows it. */
    reopen: (session: string | null) =>
      reopen({ payload: { session } }).then(() => {
        chat.clear();
        return reload();
      }),
  };
};

/** Opens the chat in its own window, resolving when it is closed, and closes it again. */
export const usePopOut = () => {
  const popOut = useAtomSet(() => popOutAtom, { mode: "promiseExit" });
  const popIn = useAtomSet(() => popInAtom, { mode: "promiseExit" });
  return {
    popOut: () => popOut({ payload: undefined }),
    popIn: () => popIn({ payload: undefined }),
  };
};

// What the Flock chat's session needs of a harness: one driver per harness it can run on.

import { Schema, type Crypto, type Effect, type FileSystem, type Path, type Stream } from "effect";
import type { AguiEvent } from "../shared/agui";
import type { Answers, ChatMessage, Conversations } from "../shared/chat-view";
import type { ShownImage } from "../shared/attachments";
import type { FlockChat } from "./flock-tools";
import type { Placement } from "./session";

/** A block of a message to the model, as the driver is handed it. */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "document";
      readonly source: {
        readonly type: "base64";
        readonly media_type: "application/pdf";
        readonly data: string;
      };
      readonly title: string;
    }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: ShownImage;
        readonly data: string;
      };
    };

/** What the driver needs to serve Collie tools and carry Desktop's turn context. */
export interface DriverContext {
  readonly dir: string;
  readonly flock: FlockChat;
  readonly run: <A>(
    effect: Effect.Effect<A, never, Crypto.Crypto | FileSystem.FileSystem>,
  ) => Promise<A>;
  readonly ask: (toolUseID: string, signal: AbortSignal) => Promise<Answers | null>;
  readonly noticed: () => string | undefined;
  readonly placement: () => Placement | undefined;
}

/** What a turn cost; counts a harness does not report are 0. */
export const TurnCost = Schema.Struct({
  duration_ms: Schema.Number,
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_read_input_tokens: Schema.Number,
    cache_creation_input_tokens: Schema.Number,
  }),
});
export type TurnCost = typeof TurnCost.Type;

/** A conversation on a harness, live until `close`. */
export interface DriverSession {
  /** The conversation's id, once the harness knows it. */
  readonly conversation: () => string | undefined;
  readonly offer: (content: string | Array<ContentBlock>) => Effect.Effect<void>;
  /** Every turn's events, ending when the harness ends the session. */
  readonly events: Stream.Stream<AguiEvent, string | Error>;
  readonly interrupt: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  /** What the latest turn cost; a new value for each turn. */
  readonly lastTurn: () => TurnCost | undefined;
  /** Whether the latest turn stopped on its Subscription's limit. */
  readonly limited: () => boolean;
}

/**
 * What the chat needs of a harness. The Machine rule and News a driver is given when it is
 * made: in a hook, or after the human's words in the message, as its harness allows.
 */
export interface ChatDriver {
  /** Whether the driver has an executable available. */
  readonly installed: boolean;
  /** Conversation `id`, resumed where the harness has it, on `model` (`default` its own). */
  readonly open: (id: string, model: string, effort: string) => Effect.Effect<DriverSession>;
  readonly transcript: (id: string) => Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly earlier: (limit: number) => Effect.Effect<Conversations["earlier"]>;
  readonly transcriptPath: (id: string) => Effect.Effect<string | null, never, Path.Path>;
}

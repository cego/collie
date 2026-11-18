import { Schema, type Effect, type FileSystem, type Path, type Scope, type Stream } from "effect";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type { AguiEvent } from "../shared/agui";
import type { Answers, ChatMessage, Earlier } from "../shared/chat-view";
import type { ShownImage } from "../shared/attachments";
import type { FlockChat } from "./flock-tools";
import type { Placement } from "./session";

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

export interface DriverContext {
  readonly dir: string;
  readonly flock: FlockChat;
  readonly run: <A>(
    effect: Effect.Effect<A, never, SecureRandom.SecureRandom | FileSystem.FileSystem>,
  ) => Promise<A>;
  readonly ask: (toolUseID: string, signal: AbortSignal) => Promise<Answers | null>;
  readonly noticed: () => string | undefined;
  readonly placement: () => Placement | undefined;
}

export const TurnCost = Schema.Struct({
  duration_ms: Schema.Finite,
  usage: Schema.Struct({
    input_tokens: Schema.Finite,
    output_tokens: Schema.Finite,
    cache_read_input_tokens: Schema.Finite,
    cache_creation_input_tokens: Schema.Finite,
  }),
});
export type TurnCost = typeof TurnCost.Type;

export interface DriverSession {
  readonly conversation: () => string | undefined;
  readonly offer: (content: string | Array<ContentBlock>) => Effect.Effect<void>;
  readonly events: Stream.Stream<AguiEvent, string | Error>;
  readonly interrupt: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly lastTurn: () => TurnCost | undefined;
  readonly limited: () => boolean;
}

export interface ChatDriver {
  readonly installed: boolean;
  readonly open: (
    id: string,
    model: string,
    effort: string | null,
  ) => Effect.Effect<DriverSession, never, Scope.Scope>;
  readonly transcript: (id: string) => Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly earlier: (limit: number) => Effect.Effect<ReadonlyArray<Earlier>>;
  readonly transcriptPath: (id: string) => Effect.Effect<string | null, never, Path.Path>;
}

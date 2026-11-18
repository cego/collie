import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Deferred, Effect } from "effect";
import { createSignal, type Accessor } from "solid-js";
import type { InputPrompts, PickItem } from "../inputs";

export type Ask =
  | { _tag: "Menu"; header: string; footer: string; items: readonly PickItem[] }
  | { _tag: "Question"; header: string; footer: string; initial: string };

export interface Pending {
  ask: Ask;
  answer: (value: string | null) => void;
}

export interface Prompting {
  prompts: InputPrompts;
  pending: Accessor<Pending | null>;
}

const MENU_FOOTER = "↑↓ move · type to filter · Enter choose · Esc cancel";
const QUESTION_FOOTER = "type an answer · Enter send · Esc cancel";

export function signalPrompts() {
  const [pending, setPending] = createSignal<Pending | null>(null);

  const waitFor = (ask: Ask) =>
    Effect.gen(function* () {
      const answered = yield* Deferred.make<string | null>();
      setPending({
        ask,
        answer: (value) => {
          setPending(null);
          Deferred.doneUnsafe(answered, Effect.succeed(value));
        },
      });
      return yield* Deferred.await(answered).pipe(
        Effect.onInterrupt(() => Effect.sync(() => setPending(null))),
      );
    });

  const returned: Prompting = {
    pending,
    prompts: {
      menu: (items, opts) =>
        Effect.map(
          waitFor({
            _tag: "Menu",
            header: opts.header,
            footer: opts.footer ?? MENU_FOOTER,
            items,
          }),
          (answer) =>
            answer === null
              ? null
              : (Option.getOrUndefined(Arr.findFirst(items, (i) => i.id === answer)) ?? null),
        ),
      ask: (question) =>
        waitFor({ _tag: "Question", header: question, footer: QUESTION_FOOTER, initial: "" }),
    },
  };
  return returned;
}

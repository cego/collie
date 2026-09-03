// A question a human answers, as state. `InputPrompts` is what the launch flow, the fork
// form and a Choice all ask through; this implements it against a signal instead of a
// terminal, so the same flow renders in the popup and inline in the tab.
//
// The other half of that interface — a question a Run answers — stays where it is:
// `filePrompts` writes it into the run dir, and an unattended Run must never come to
// depend on a renderer being there.

import { Deferred, Effect } from "effect";
import { createSignal, type Accessor } from "solid-js";
import type { InputPrompts, PickItem } from "../inputs";

/** What is being asked, in the shape the component renders. */
export type Ask =
  | { _tag: "Menu"; header: string; footer: string; items: readonly PickItem[] }
  | { _tag: "Question"; header: string; footer: string; initial: string };

/** A question, and the one answer it is waiting for. */
export interface Pending {
  ask: Ask;
  /** The chosen item's id, the typed text, or `null` for a cancel. */
  answer: (value: string | null) => void;
}

export interface Prompting {
  /** Handed to the flow, which cannot tell this from the terminal one it replaced. */
  prompts: InputPrompts;
  /** What the component draws, or nothing while the flow is between questions. */
  pending: Accessor<Pending | null>;
}

const MENU_FOOTER = "↑↓ move · type to filter · Enter choose · Esc cancel";
const QUESTION_FOOTER = "type an answer · Enter send · Esc cancel";

/**
 * Questions asked one at a time, through a signal rather than a terminal. Each call
 * parks until the component answers it, which is what lets a flow written as a sequence
 * of `menu`/`ask` calls drive a component tree without either half knowing about the
 * other.
 */
export function signalPrompts(): Prompting {
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
      // Cleared on the way out too: an interrupted flow must not leave a question on
      // screen that nothing is waiting for any more.
      return yield* Deferred.await(answered).pipe(
        Effect.onInterrupt(() => Effect.sync(() => setPending(null))),
      );
    });

  return {
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
          (answer) => (answer === null ? null : (items.find((i) => i.id === answer) ?? null)),
        ),
      ask: (question) =>
        waitFor({ _tag: "Question", header: question, footer: QUESTION_FOOTER, initial: "" }),
    },
  };
}

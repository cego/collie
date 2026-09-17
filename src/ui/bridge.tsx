// The only file that knows both worlds. State in: an Effect fiber re-reads what the
// showing View needs and writes it into a Solid signal. Commands out: a component's
// `dispatch` puts plain data on a queue an Effect fiber drains. Nothing crosses in any
// other direction — components never hold an Effect, and the handlers never render.

import { Deferred, Effect, Fiber, FileSystem, Queue, Scope, Stream, SubscriptionRef } from "effect";
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, ErrorBoundary, onMount, Show, type Accessor } from "solid-js";
import { reason } from "../naming";
import type { InputPrompts } from "../inputs";
import { App } from "./App";
import { Flow } from "./Flow";
import { signalPrompts, type Pending } from "./prompts";
import {
  changesFocusOnly,
  retarget,
  type AppState,
  type Command,
  type Filter,
  type Focus,
  type FocusCommand,
} from "./state";
import type { Selection } from "../selection";

// Re-exported where it was declared: the Focus is the bridge's own state, and it moved
// into the state layer so the reads it decides can be tested as the plain data they are.
export type { Focus };

/**
 * The backstop behind the watch. `fs.watch` drops events on some filesystems and says
 * nothing when it does; a poll alone is what made the old board feel dead. So: the watch
 * for latency, the tick so a missed event costs latency rather than the update.
 */
const POLL_MS = 3_000;

/**
 * How long a stop is held on the board before the Driver hears about it. The whole point
 * of the wait: nothing is signalled and nothing is written, so an undo inside it takes
 * back a decision rather than racing one.
 */
const GRACE_MS = 5_000;

export interface Bridge<E, R> {
  /** Everything the app draws, for what is being looked at. Never called in a render. */
  load: (focus: Focus) => Effect.Effect<AppState, E, R>;
  /**
   * What a command does. Its string becomes the footer note; `null` says nothing. The
   * prompts are how a command that needs the human asks — the launch flow run inline in
   * the tab is the same flow the popup runs, drawn through the same components.
   */
  act: (command: Command, prompts: InputPrompts) => Effect.Effect<string | null, E, R>;
  /** Where a change to a Run shows up, which is what the watch is put on. */
  stateDir: string;
  /** The brand mark's file, drawn as a bitmap where the terminal can. */
  logo?: string;
  /** Which of the Herd's work the board opens on, decided once at startup. */
  filter: Filter;
  /** The workspace this board was opened from, which `g` narrows to. */
  origin: string | null;
  /**
   * What the board has selected, for whoever is outside the tab: the status line under
   * the chat prompt, and the tools a conversation asks with no run of its own. Optional,
   * because a bridge in a test has nobody to tell.
   */
  selected?: (on: Selection | null) => Effect.Effect<void, E, R>;
  /** The stop grace, in milliseconds. Shortened only by a test. */
  graceMs?: number;
  /**
   * Handed this board's own `dispatch` once it is running. What a confirmed `navigate`
   * needs: an executor is an Effect and the Selection is the app's, so this is the one
   * wire between them — and it is a dispatch, never a herdr focus call.
   */
  onReady?: (dispatch: (command: Command) => void) => void;
}

/**
 * A flow that asks a human questions, in a renderer of its own. This is what the popup
 * panes run: `pickFlow` and its siblings are still a sequence of `menu`/`ask` calls, and
 * this is what draws them — the same components the tab draws inline, in a different
 * placement.
 *
 * Scoped, so the pane gets its terminal back whether the flow finished, cancelled or was
 * killed.
 */
export function runFlow<A, E, R>(
  body: (prompts: InputPrompts) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const { prompts, pending } = signalPrompts();
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
      (r) => Effect.sync(() => r.destroy()),
    );
    yield* Effect.promise(() =>
      render(
        () => (
          <ErrorBoundary
            fallback={(thrown: Error) => (
              <StoppedDrawing
                why={reason(thrown)}
                what="q abandons this; nothing has been started."
                // Cancelling the question in flight is what ends the flow: every one of
                // them treats a `null` answer as "the human backed out" and returns.
                onQuit={() => pending()?.answer(null)}
              />
            )}
          >
            <Show when={pending()}>
              <Flow pending={pending()!} />
            </Show>
          </ErrorBoundary>
        ),
        renderer,
      ),
    );
    return yield* body(prompts);
  }).pipe(Effect.scoped);
}

/**
 * What a pane shows when a render threw: one line, and a key that actually works.
 *
 * Its own `useKeyboard`, and that is the point of it. `App`'s handler is registered
 * through `useKeyboard`, which removes it in `onCleanup` — so the moment this boundary
 * replaces `App` there is no `q` left, `exitOnCtrlC` is off, and the pane was stuck
 * until it was killed from outside. `App`'s `onBlur` went the same way, which left
 * `renderer.useMouse` true and took copy-and-paste out of every other herdr pane, so
 * the mouse is given back here too.
 */
export function StoppedDrawing(props: { why: string; what: string; onQuit: () => void }) {
  const renderer = useRenderer();
  onMount(() => {
    renderer.useMouse = false;
  });
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) props.onQuit();
  });
  return (
    <box style={{ flexDirection: "column" }}>
      <text>{`Collie stopped drawing: ${props.why}`}</text>
      <text>{props.what}</text>
    </box>
  );
}

/** The bridge, running: what to render, what to call, and when it has been closed. */
export interface Driven {
  /** What the app renders. A plain accessor, so this is readable without a renderer. */
  state: () => AppState;
  /** The question a flow running inline is waiting on, or nothing. */
  pending: Accessor<Pending | null>;
  /** What a component calls. Synchronous, because it is a plain prop. */
  dispatch: (command: Command) => void;
  /** Completes once a `Quit` has been drained. */
  closed: Effect.Effect<void>;
}

/**
 * Both arrows, and nothing about a terminal: the state stream, the command loop, and the
 * signal between them. Separate from `runApp` because this is the part with behaviour —
 * superseding, cancellation, ordering — and a test should be able to drive it without a
 * renderer to own.
 *
 * Forks into the caller's scope, so `runApp`'s scope is what ends both fibers.
 */
export function driveBridge<E, R>(
  bridge: Bridge<E, R>,
): Effect.Effect<Driven, E, R | FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // The tab asks its questions through the same components the popup does; this is the
    // inline placement of the one input model.
    const { prompts, pending } = signalPrompts();
    /**
     * Two queues, because they must not be able to block each other. Control — the
     * focus changes and the close — is instantaneous; work is a `glab` call or a run
     * being stopped. One queue put every keypress behind whatever the last command was
     * still doing, which is a stalled cursor every time a merge request is read.
     */
    const control = yield* Queue.make<FocusCommand>();
    const work = yield* Queue.make<Command>();
    /**
     * The third lane: a stop waiting out its grace, and the undo that takes it back.
     * Its own, because the wait is five seconds long — on the work queue it would hold
     * up every command behind it, and on the control queue it would stall the keyboard.
     */
    const stops = yield* Queue.make<Extract<Command, { _tag: "StopRun" | "UndoStop" }>>();
    const closed = yield* Deferred.make<void>();

    /**
     * What is being looked at, as one source everything reads. Held here rather than in
     * a component: which View is showing and what is selected decide what the producers
     * read, so they are state, not render-local signals.
     */
    const focus = yield* SubscriptionRef.make<Focus>({
      view: "runs",
      // The filter the board opens on — the origin workspace under `scope: local`, the
      // whole Herd otherwise — and the workspace `g` narrows back to.
      filter: bridge.filter,
      origin: bridge.origin,
      previewing: null,
      shown: ["runs"],
      selected: null,
      tail: false,
      reviewPages: 1,
      nonce: 0,
    });
    const [state, setState] = createSignal<AppState>(
      yield* bridge.load(yield* SubscriptionRef.get(focus)),
    );

    /** What has been marked and not yet sent, by Run, with the fiber counting it down. */
    const waiting = new Map<string, Fiber.Fiber<unknown, unknown>>();
    const marked = () => setState((previous) => ({ ...previous, stopping: [...waiting.keys()] }));

    /**
     * A read that fails says so in the footer and leaves the last state on screen. The
     * alternative is the state fiber dying on one bad read and the tab silently freezing
     * on a board from minutes ago.
     */
    const stated = <A,>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            setState((previous) => ({ ...previous, note: reason(cause).split("\n")[0]! }));
            return { ok: false as const };
          }),
        ),
      );

    /**
     * What might mean the state has changed: the run dirs moving, and a slow tick behind
     * them because `fs.watch` drops events on some filesystems and says nothing when it
     * does. A tick carries the focus as it stands, so it never overrides one.
     */
    const ticks = Stream.merge(
      fs.watch(bridge.stateDir, { recursive: true }).pipe(Stream.catchCause(() => Stream.empty)),
      Stream.tick(`${POLL_MS} millis`),
    ).pipe(Stream.mapEffect(() => SubscriptionRef.get(focus)));

    /**
     * One writer of `state`, and the load in flight is interrupted the moment a newer
     * focus arrives. Holding a cursor key used to queue one full read per keypress and
     * run every one of them, and a read that started earlier could land after a newer
     * one and put a stale board back on screen. `switchMap` is what makes the newest
     * focus the only one that finishes.
     */
    yield* Effect.forkScoped(
      Stream.merge(SubscriptionRef.changes(focus), ticks).pipe(
        Stream.switchMap((at) => Stream.fromEffect(stated(bridge.load(at)))),
        Stream.runForEach((next) =>
          Effect.sync(() => {
            // The note and the marks are the bridge's own: a load knows nothing about
            // either, and taking its word for them would wipe both every three seconds.
            if (next.ok)
              setState((previous) => ({
                ...next.value,
                note: previous.note,
                stopping: previous.stopping,
              }));
          }),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const command = yield* Queue.take(control);
          // Ignored rather than reported: a record chat reads is not worth a board that
          // stops answering the keyboard, and this lane has to stay instantaneous.
          const tell = (on: Selection | null) =>
            bridge.selected === undefined ? Effect.void : Effect.ignore(bridge.selected(on));
          // A board nobody has open has nothing selected.
          if (command._tag === "Quit") {
            yield* tell(null);
            return yield* Deferred.succeed(closed, undefined);
          }
          yield* SubscriptionRef.update(focus, (at) => retarget(at, command));
          if (command._tag === "Select") yield* tell(command.on);
        }),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const command = yield* Queue.take(stops);
          if (command._tag === "UndoStop") {
            const counting = [...waiting.values()];
            waiting.clear();
            marked();
            return yield* Effect.forEach(counting, Fiber.interrupt, { discard: true });
          }
          // Already counting down: a second press is not a second stop.
          if (waiting.has(command.runId)) return;
          const fiber = yield* Effect.forkScoped(
            Effect.sleep(`${bridge.graceMs ?? GRACE_MS} millis`).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  waiting.delete(command.runId);
                  marked();
                }),
              ),
              // Onto the work queue, so the stop itself is an ordinary command: the note
              // it returns is the one the human reads, and the board re-reads after it.
              Effect.andThen(Queue.offer(work, command)),
            ),
          );
          waiting.set(command.runId, fiber);
          marked();
        }),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const command = yield* Queue.take(work);
          const note = yield* stated(bridge.act(command, prompts));
          // Only when it worked. A failure has already put its reason in the footer, and
          // overwriting that unconditionally erased every message a failed action left —
          // which is the whole of the feedback the human gets for one.
          if (note.ok) setState((previous) => ({ ...previous, note: note.value ?? null }));
          // What the command did is on disk now, so the state stream is asked to look
          // again rather than this fiber writing a second version of the state.
          yield* SubscriptionRef.update(focus, (at) => ({ ...at, nonce: at.nonce + 1 }));
        }),
      ),
    );

    return {
      state,
      pending,
      dispatch: (command) => {
        if (command._tag === "StopRun" || command._tag === "UndoStop")
          Queue.offerUnsafe(stops, command);
        else if (changesFocusOnly(command)) Queue.offerUnsafe(control, command);
        else Queue.offerUnsafe(work, command);
      },
      closed: Deferred.await(closed),
    } satisfies Driven;
  });
}

/**
 * Runs the Collie tab until it is closed or interrupted. Scoped, so the renderer gives
 * the terminal back even when the pane is killed rather than quit.
 */
export function runApp<E, R>(
  bridge: Bridge<E, R>,
): Effect.Effect<void, E, R | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const driven = yield* driveBridge(bridge);
    bridge.onReady?.(driven.dispatch);
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
      (r) => Effect.sync(() => r.destroy()),
    );
    // A throw inside a render would otherwise take the pane down with it, and the text
    // view — the escape hatch this whole thing keeps alive — would never be reached
    // because the process is already gone. One boundary, one line, and `q` still works.
    yield* Effect.promise(() =>
      render(
        () => (
          <ErrorBoundary
            // Declared as an Error because that is what a render throws; `reason` is
            // what copes when something threw a string instead, and it is the parse at
            // this boundary — nothing past here sees the raw value.
            fallback={(thrown: Error) => (
              <StoppedDrawing
                why={reason(thrown)}
                what="q closes this tab; reopening it starts a fresh one."
                onQuit={() => driven.dispatch({ _tag: "Quit" })}
              />
            )}
          >
            <App
              state={driven.state}
              pending={driven.pending}
              dispatch={driven.dispatch}
              logo={bridge.logo}
            />
          </ErrorBoundary>
        ),
        renderer,
      ),
    );
    yield* driven.closed;
  }).pipe(Effect.scoped);
}

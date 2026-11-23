import * as Str from "effect/String";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render, useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, ErrorBoundary, onMount, Show, type Accessor } from "solid-js";
import { reason } from "../naming";
import { isHostLog } from "../host-log";
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

export type { Focus };

// WARNING: fs.watch drops events silently on some filesystems; the tick makes a missed event cost latency, not the update.
const POLL_MS = 3000;

// WARNING: nothing is signalled or written during the grace, so an undo takes back a decision rather than racing one.
const GRACE_MS = 5000;

export interface Bridge<E, R> {
  load: (focus: Focus) => Effect.Effect<AppState, E, R>;
  act: (command: Command, prompts: InputPrompts) => Effect.Effect<string | null, E, R>;
  stateDir: string;
  changes?: Stream.Stream<unknown>;
  logo?: string;
  filter: Filter;
  origin: string | null;
  selected?: (on: Selection | null) => Effect.Effect<void, E, R>;
  graceMs?: number;
  onReady?: (dispatch: (command: Command) => void) => void;
}

export const closeRenderer = (renderer: Pick<CliRenderer, "destroy" | "closed">) =>
  Effect.sync(() => renderer.destroy()).pipe(
    Effect.andThen(Effect.tryPromise(() => renderer.closed)),
    Effect.ignore({ log: "Warn" }),
  );

export function runFlow<A, E, R>(body: (prompts: InputPrompts) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const { prompts, pending } = signalPrompts();
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
      closeRenderer,
    );
    yield* Effect.promise(() =>
      render(
        () => (
          <ErrorBoundary
            fallback={(thrown: Error) => (
              <StoppedDrawing
                why={reason(thrown)}
                what="q abandons this; nothing has been started."
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

// WARNING: has its own key handler: App's is removed on unmount, which would leave no key to quit with.
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

export interface Driven {
  state: () => AppState;
  pending: Accessor<Pending | null>;
  dispatch: (command: Command) => void;
  closed: Effect.Effect<void>;
}

export function driveBridge<E, R>(bridge: Bridge<E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { prompts, pending } = signalPrompts();
    // WARNING: control and work are separate queues: a slow command must not stall the keyboard.
    const control = yield* Queue.make<FocusCommand>();
    const work = yield* Queue.make<Command>();
    // WARNING: its own lane: on the work queue a stop would hold up every command behind it.
    const stops = yield* Queue.make<Extract<Command, { _tag: "StopRun" | "UndoStop" }>>();
    const closed = yield* Deferred.make<void>();

    const focus = yield* SubscriptionRef.make<Focus>({
      view: "runs",
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
    let loadNote = state().note;

    const waiting = new Map<string, Fiber.Fiber<unknown, unknown>>();
    const marked = () => setState((previous) => ({ ...previous, stopping: [...waiting.keys()] }));

    // WARNING: a failed read says so and keeps the last state, instead of freezing the tab on one bad read.
    const stated = <A,>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            setState((previous) => ({ ...previous, note: Str.split(reason(cause), "\n")[0]! }));
            return { ok: false as const };
          }),
        ),
      );

    const ticks = yield* Stream.merge(
      fs.watch(bridge.stateDir, { recursive: true }).pipe(
        Stream.filter(
          ({ path }) => !isHostLog(path) && path !== "usage" && !Str.startsWith("usage/")(path),
        ),
        Stream.catchCause(() => Stream.empty),
      ),
      Stream.tick(`${POLL_MS} millis`).pipe(Stream.drop(1)),
    ).pipe(
      Stream.merge(bridge.changes ?? Stream.empty),
      Stream.share({ capacity: 1, strategy: "sliding", idleTimeToLive: Duration.infinity }),
    );

    yield* Effect.forkScoped(
      SubscriptionRef.changes(focus).pipe(
        Stream.switchMap((at) =>
          Stream.concat(Stream.make(undefined), ticks).pipe(
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.mapEffect(() => stated(bridge.load(at))),
          ),
        ),
        Stream.runForEach((next) =>
          Effect.sync(() => {
            if (!next.ok) return;
            const said = next.value.note;
            setState((previous) => ({
              ...next.value,
              note: said ?? (previous.note === loadNote ? null : previous.note),
              stopping: previous.stopping,
            }));
            loadNote = said;
          }),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const command = yield* Queue.take(control);
          const tell = (on: Selection | null) =>
            bridge.selected === undefined ? Effect.void : Effect.ignore(bridge.selected(on));
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
          if (waiting.has(command.runId)) return;
          const fiber = yield* Effect.forkScoped(
            Effect.sleep(`${bridge.graceMs ?? GRACE_MS} millis`).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  waiting.delete(command.runId);
                  marked();
                }),
              ),
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
          // WARNING: only when it worked: a failure already put its reason in the footer, which an unconditional write erases.
          if (note.ok) setState((previous) => ({ ...previous, note: note.value ?? null }));
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

export function runApp<E, R>(bridge: Bridge<E, R>) {
  return Effect.gen(function* () {
    const driven = yield* driveBridge(bridge);
    bridge.onReady?.(driven.dispatch);
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
      closeRenderer,
    );
    yield* Effect.promise(() =>
      render(
        () => (
          <ErrorBoundary
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

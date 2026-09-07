// The bridge's own behaviour, with no renderer to own: a newer focus interrupts the read
// in flight, and a slow command never stalls the next keypress. Both were real holes —
// holding a cursor key queued one full read per press and ran every one of them, and a
// `glab` call sat in the same queue in front of the next Select.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { driveBridge, type Focus } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/**
 * A state that says which focus produced it. `repo` rather than `note`, because the note
 * is the footer's own line: a load keeps whatever the last command said there.
 */
function stateFor(selected: string | null): AppState {
  return {
    view: "runs",
    scope: "local",
    wide: null,
    board: {
      repo: selected ?? "none",
      cwd: "/w/collie",
      worktrees: [],
      behind: null,
      now: 0,
      agents: [],
      extraAgents: 0,
      active: [],
      recent: [],
    },
    note: null,
    history: null,
    definitions: null,
    settings: null,
    detail: null,
  };
}

/** Waits for something the fibers do, rather than for a duration. */
const until = Effect.fn("supersede.until")(function* (what: string, ready: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (ready()) return;
    yield* Effect.sleep("5 millis");
  }
  return yield* Effect.fail(new Error(`${what} never happened`));
});

test("a newer focus interrupts the read in flight, and the newer one lands", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const started: string[] = [];
        const interrupted: string[] = [];
        // The first Select's read never finishes on its own, so the only way the second
        // one can land is by interrupting it.
        const held = yield* Deferred.make<void>();

        const driven = yield* driveBridge({
          scope: "local" as const,
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.gen(function* () {
              const which = focus.selected ?? "none";
              started.push(which);
              if (which === "run:a") yield* Deferred.await(held);
              return stateFor(focus.selected);
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted.push(focus.selected ?? "none");
                }),
              ),
            ),
          act: () => Effect.succeed(null),
        });

        driven.dispatch({ _tag: "Select", id: "run:a" });
        yield* until("the first read to start", () => started.includes("run:a"));

        driven.dispatch({ _tag: "Select", id: "run:b" });
        yield* until("the second read to land", () => driven.state().board.repo === "run:b");

        // Superseded, not merely ignored: the fiber was actually stopped.
        expect(interrupted).toContain("run:a");
        expect(driven.state().board.repo).toBe("run:b");
      }),
    ),
  ));

test("a command that takes its time does not stall the next keypress", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Command[] = [];
        const slow = yield* Deferred.make<void>();

        const driven = yield* driveBridge({
          scope: "local" as const,
          stateDir: rig.stateDir,
          load: (focus: Focus) => Effect.succeed(stateFor(focus.selected)),
          act: (command) =>
            Effect.gen(function* () {
              acted.push(command);
              // A `glab` call, as far as the queue is concerned.
              yield* Deferred.await(slow);
              return "done";
            }),
        });

        driven.dispatch({ _tag: "OpenMr", target: "mr:host/g/p!1", runId: null });
        yield* until("the command to start", () => acted.length === 1);

        // The Selection moves while that is still going: it is a focus change, so it
        // never joins the queue the command is sitting in.
        driven.dispatch({ _tag: "Select", id: "run:b" });
        yield* until("the Selection to land", () => driven.state().board.repo === "run:b");

        expect(driven.state().board.repo).toBe("run:b");
        yield* Deferred.succeed(slow, undefined);
      }),
    ),
  ));

test("a Refresh asked for twice is read twice, because a repeat is the whole point", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const nonces: number[] = [];

        const driven = yield* driveBridge({
          scope: "local" as const,
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.sync(() => {
              nonces.push(focus.nonce);
              return stateFor(focus.selected);
            }),
          act: () => Effect.succeed(null),
        });

        driven.dispatch({ _tag: "Refresh" });
        yield* until("the first re-read", () => nonces.includes(1));
        driven.dispatch({ _tag: "Refresh" });
        yield* until("the second re-read", () => nonces.includes(2));

        // The same focus twice: without the nonce, `changes` would drop the second as a
        // repeat and pressing the key again would do nothing.
        expect(nonces).toContain(1);
        expect(nonces).toContain(2);
      }),
    ),
  ));

test("a command that fails leaves its reason in the footer", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const driven = yield* driveBridge({
          scope: "local" as const,
          stateDir: rig.stateDir,
          load: (focus: Focus) => Effect.succeed(stateFor(focus.selected)),
          act: () => Effect.fail(new Error("glab could not reach gitlab.example.com")),
        });

        driven.dispatch({ _tag: "OpenMr", target: "mr:host/g/p!1", runId: null });
        yield* until("the failure to reach the footer", () => driven.state().note !== null);

        // The reason used to be written and then immediately overwritten with null, so a
        // failed action gave the human nothing at all.
        expect(driven.state().note).toContain("glab could not reach");

        // And a load after it keeps the reason on screen rather than clearing it.
        driven.dispatch({ _tag: "Refresh" });
        yield* Effect.sleep("30 millis");
        expect(driven.state().note).toContain("glab could not reach");
      }),
    ),
  ));

test("the board opens on the scope from config, and g is what changes it after", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const scopes: string[] = [];

        const driven = yield* driveBridge({
          // What `loadDefaults` answered: nothing else remembers the scope, so this is
          // the whole of "the board opens the way I use it".
          scope: "all" as const,
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.sync(() => {
              scopes.push(focus.scope);
              return { ...stateFor(focus.selected), scope: focus.scope };
            }),
          act: () => Effect.succeed(null),
        });

        expect(scopes[0]).toBe("all");

        // Waited on the state, not on the load having been called: `scopes.push`
        // happens inside the load and the stream writes the state a moment later, so
        // asserting on the first was a pass about one run in eight.
        driven.dispatch({ _tag: "ToggleScope" });
        yield* until("the narrowed board", () => driven.state().scope === "local");
        expect(scopes).toContain("local");
      }),
    ),
  ));

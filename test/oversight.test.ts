// What a human reads a Run's progress from while nobody is watching its panes: the cards
// the host writes as the work reaches its moments, and the toast when one is worth it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, type Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { Agents, agentsLayer } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { foundationLayer, loadEntry, runDir } from "../src/engine";
import { Oversight } from "../src/oversight";
import { readCards } from "../src/cards";
import type { Store } from "../src/store";
import { fixtures } from "./support/host";

let rig: Rig;
let dir: string;
let toasts: string[];

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      toasts = [];
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const nothing = () => Effect.die("no children here");

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Oversight
    | Store
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  run.pipe(
    Effect.provide(
      agentsLayer({
        dir,
        env: rig.pluginEnv(),
        herdr: new FakeHerdr(rig.pluginEnv()),
        harness: "claude",
        model: "opus",
        permissions: "bypass",
        compactAtTokens: 0,
      }),
    ),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(
      foundationLayer({
        dir,
        toast: (title, body, sound) => Effect.sync(() => toasts.push(`${sound}|${title}|${body}`)),
      }),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const cardsOf = (runId: string) => readCards(runDir(dir, runId)).pipe(Effect.orDie);

const executed = (entry: string, runId: string, input: Readonly<Record<string, Schema.Json>>) =>
  session(
    Effect.gen(function* () {
      const described = yield* loadEntry(`${fixtures}/${entry}`).pipe(Effect.orDie);
      const made = described.make(`${described.id}@${runId}`);
      return yield* made.workflow
        .execute({ runId, input })
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
  );

test("a Run that ends leaves the card that closes it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* executed("hello.workflow.ts", "r1", { name: "you" });
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => `${card.kind}:${card.step}`)).toEqual(["final:finish"]);
      expect(cards[0]!.aligned).toBe("unverified");
    }),
  ));

test("a card a human could go and try says so, and a routine one does not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The host's own directory is where a Run nobody placed works: a change there is
      // something to look at.
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          yield* oversight.card("r1", { kind: "slice", step: "build", claims: [] });
          yield* fs.writeFileString(`${dir}/thing.ts`, "export const one = 1;\n");
          yield* oversight.card("r1", { kind: "slice", step: "build", claims: ["built it"] });
        }),
      );
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => `${card.readiness}/${card.significance}`)).toEqual([
        "claimed/routine",
        "inspect-ready/try-it",
      ]);
      expect(toasts).toEqual([
        "done|host · r1 has a slice you can try (inspect-ready)|inspect-ready",
      ]);
    }),
  ));

test("a ticket an agent says it finished is carded once, with its own words as claims", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const progress = `${runDir(dir, "r1")}/steering/progress`;
      yield* fs.makeDirectory(progress, { recursive: true });
      yield* fs.writeFileString(
        `${progress}/01-parse.json`,
        `{"ticket":"01-parse.md","status":"done","claims":["parses the file"],"at":"2026-09-25T00:00:00Z"}`,
      );
      yield* fs.writeFileString(
        `${progress}/02-print.json`,
        `{"ticket":"02-print.md","status":"started","claims":[],"at":"2026-09-25T00:01:00Z"}`,
      );
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          yield* oversight.checkpoints("r1", "build");
          yield* oversight.checkpoints("r1", "build");
        }),
      );
      // A second host looks again and finds nothing new.
      yield* session(Oversight.pipe(Effect.flatMap((one) => one.checkpoints("r1", "build"))));
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => card.claims.map((claim) => claim.text))).toEqual([
        ["parses the file"],
      ]);
      expect(cards[0]!.step).toBe("build");
    }),
  ));

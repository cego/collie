import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Path } from "effect";
import { expect, test } from "bun:test";
import { runEffect } from "./support/effect";

const srcDir = new URL("../src/", import.meta.url).pathname;

const sources = Effect.fn("test.sources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<{ name: string; text: string }> = [];
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of yield* fs.readDirectory(dir)) {
      const full = path.join(dir, name);
      if ((yield* fs.stat(full)).type === "Directory") {
        stack.push(full);
        continue;
      }
      if (!pipe(name, Str.endsWith(".ts")) && !pipe(name, Str.endsWith(".tsx"))) {
        continue;
      }
      found.push({ name: path.relative(srcDir, full), text: yield* fs.readFileString(full) });
    }
  }
  return found;
});

test("only the Dispatcher sends text to an agent", () =>
  runEffect(
    Effect.gen(function* () {
      const senders = Arr.map(
        Arr.filter(yield* sources(), (file) => pipe(file.text, Str.includes("agentPrompt("))),
        (file) => file.name,
      ).sort();
      expect(senders).toEqual(["dispatcher.ts", "herdr.ts"]);
    }),
  ));

test("only steering.ts names the delivery ledger", () =>
  runEffect(
    Effect.gen(function* () {
      const writers = Arr.map(
        Arr.filter(yield* sources(), (file) =>
          /(?:^|[^\w.-])deliveries\.jsonl(?:$|[^\w.-])/.test(file.text),
        ),
        (file) => file.name,
      ).sort();
      expect(writers).toEqual(["steering.ts"]);
    }),
  ));

test("an action kind is registered by the module that owns the operation, and nowhere else", () =>
  runEffect(
    Effect.gen(function* () {
      const owners = new Set(["executors.ts", "run-actions.ts", "commands/steer.ts", "home.ts"]);
      const strays = Arr.filter(
        Arr.map(
          Arr.filter(yield* sources(), (file) =>
            pipe(file.text, Str.includes("registerExecutor(")),
          ),
          (file) => file.name,
        ),
        (name) => !owners.has(name),
      );
      expect(strays).toEqual([]);
    }),
  ));

test("nobody stamps a human actor; who is human is derived", () =>
  runEffect(
    Effect.gen(function* () {
      // WARNING: the journal records who settled what; actorNow(env, id) is the only way to name a human.
      const stampers = Arr.map(
        Arr.filter(yield* sources(), (file) => /["'`]human:\$\{/.test(file.text)),
        (file) => file.name,
      ).sort();
      expect(stampers).toEqual([]);
    }),
  ));

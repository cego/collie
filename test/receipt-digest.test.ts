import { expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { mutation } from "../src/envelope";
import type { Call } from "../src/envelope";
import type { PluginEnv } from "../src/env";
import { runEffect } from "./support/effect";

const envIn: (dir: string, extra?: Partial<PluginEnv>) => PluginEnv = (dir, extra = {}) => ({
  pluginRoot: dir,
  home: dir,
  collieDir: dir,
  userDir: dir,
  claudeManagedDir: dir,
  stateDir: dir,
  gitlabLogin: null,
  githubLogin: null,
  cwd: dir,
  cwdExplicit: true,
  raw: {},
  ...extra,
});

const applied = (id: string) => Effect.succeed({ ok: true as const, data: { id }, human: id });

const asked = (call: Call, env: PluginEnv, id: string) =>
  mutation(env, call, Option.some(id), applied);

const refused = { ok: false, error: { code: "invalid_input" } };

test("a receipt is one operation, one caller, one destination and one set of arguments", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const call: Call = { operation: "one", run: null, args: { a: 1, b: { c: 2 } } };
      const first = yield* asked(call, envIn(dir), "same-id");
      expect(first).toMatchObject({ ok: true });

      expect(yield* asked({ ...call, args: { b: { c: 2 }, a: 1 } }, envIn(dir), "same-id")).toEqual(
        first,
      );
      expect(yield* asked(call, envIn(dir, { cwd: "/elsewhere" }), "same-id")).toEqual(first);

      expect(yield* asked(call, envIn(dir, { machine: "other" }), "same-id")).toMatchObject(
        refused,
      );
      expect(yield* asked(call, envIn(dir, { caller: "run-other" }), "same-id")).toMatchObject(
        refused,
      );
      expect(
        yield* asked({ ...call, destination: "cwd" }, envIn(dir, { cwd: "/elsewhere" }), "same-id"),
      ).toMatchObject(refused);
      expect(
        yield* asked(
          { operation: "two", run: null, args: { a: 1, b: { c: 2 } } },
          envIn(dir),
          "same-id",
        ),
      ).toMatchObject(refused);

      expect(yield* asked(call, envIn(dir), "same-id")).toEqual(first);
    }),
  ));

test("a receipt written before receipts were scoped is read by operation alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${dir}/requests/one`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/requests/one/old.json`,
        '{"ok":true,"data":{"run":"run-a","runId":"run-a"},"human":"held"}\n',
      );
      const mine: Call = { operation: "one", run: "run-a", args: { reason: "because" } };
      expect(yield* asked(mine, envIn(dir), "old")).toMatchObject({ ok: true });
      expect(yield* asked({ ...mine, operation: "two" }, envIn(dir), "old")).toMatchObject(refused);
    }),
  ));

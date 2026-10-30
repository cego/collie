import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { approvedFrom } from "../src/verify-spec";
import { runEffect } from "./support/effect";

const workflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      steps: Schema.Array(
        Schema.Struct({
          run: Schema.optionalKey(Schema.String),
          "working-directory": Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});

const workflow = Effect.promise(() =>
  Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
).pipe(
  Effect.map((text) =>
    flow(Schema.decodeUnknownResult(workflowSchema), Result.getOrThrow)(Bun.YAML.parse(text)),
  ),
);

test("every CI job that checks the root installs Desktop's dependencies before it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { jobs } = yield* workflow;
      const checking = Arr.filter(Rec.values(jobs), (job) =>
        Arr.some(job.steps, (step) => /^bun run (check|test)\b/.test(step.run ?? "")),
      );
      expect(checking.length).toBeGreaterThan(0);
      for (const { steps } of checking) {
        const rootInstall = Option.getOrElse(
          Arr.findFirstIndex(
            steps,
            (step) => step.run === "bun install --frozen-lockfile" && !step["working-directory"],
          ),
          () => -1,
        );
        const desktopInstall = Option.getOrElse(
          Arr.findFirstIndex(
            steps,
            (step) =>
              step.run === "bun install --frozen-lockfile" &&
              step["working-directory"] === "desktop",
          ),
          () => -1,
        );
        const check = Option.getOrElse(
          Arr.findFirstIndex(steps, (step) => /^bun run (check|test)\b/.test(step.run ?? "")),
          () => -1,
        );

        expect(rootInstall).toBeGreaterThanOrEqual(0);
        expect(desktopInstall).toBeGreaterThan(rootInstall);
        expect(check).toBeGreaterThan(desktopInstall);
      }
    }),
  ));

test("Collie's own check is left to the CI job whose needs run each part of it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-own-checks-" });
      const root = fileURLToPath(new URL("..", import.meta.url));
      const checks = yield* approvedFrom({ cwd: root, userDir });
      expect(checks).toEqual([
        { name: "check", executable: "bun", argv: ["run", "check"], cwd: "worktree", ci: "test" },
      ]);

      const { jobs } = yield* workflow;
      const gate = jobs[checks[0]!.ci!];
      const runs = Arr.flatMap(
        [gate?.needs ?? []].flat(),
        (name) =>
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(jobs[name]), (present) =>
              Arr.map(present.steps, (step) => step.run),
            ),
          ) ?? [],
      );
      const { scripts } = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ check: Schema.String }) })),
      )(yield* fs.readFileString(`${root}/package.json`)).pipe(Effect.orDie);
      const parts = Str.split(scripts.check, " && ");
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts)
        expect(
          Arr.some(runs, (run) =>
            Boolean(
              run === part ||
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(run), (present_) =>
                  pipe_(present_, Str.startsWith(`${part} `)),
                ),
              ),
            ),
          ),
        ).toBe(true);
    }),
  ));

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { approvedFrom } from "../src/verify-spec";
import { runEffect } from "./support/effect";

const workflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    test: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          run: Schema.optionalKey(Schema.String),
          "working-directory": Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
});

test("the root CI gate installs Desktop's dependencies before checking its imports", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const text = yield* Effect.promise(() =>
        Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
      );
      const { jobs } = Schema.decodeUnknownSync(workflowSchema)(Bun.YAML.parse(text));
      const steps = jobs.test.steps;
      const rootInstall = steps.findIndex(
        (step) => step.run === "bun install --frozen-lockfile" && !step["working-directory"],
      );
      const desktopInstall = steps.findIndex(
        (step) =>
          step.run === "bun install --frozen-lockfile" && step["working-directory"] === "desktop",
      );
      const check = steps.findIndex((step) => step.run === "bun run check");

      expect(rootInstall).toBeGreaterThanOrEqual(0);
      expect(desktopInstall).toBeGreaterThan(rootInstall);
      expect(check).toBeGreaterThan(desktopInstall);
    }),
  ));

const jobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })),
    }),
  ),
});

test("Collie's own check is left to the CI job that runs the same command", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-own-checks-" });
      const checks = yield* approvedFrom({
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        userDir,
      });
      expect(checks).toEqual([
        { name: "check", executable: "bun", argv: ["run", "check"], cwd: "worktree", ci: "test" },
      ]);

      const text = yield* fs.readFileString(
        fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
      );
      const { jobs } = Schema.decodeUnknownSync(jobsSchema)(Bun.YAML.parse(text));
      const [check] = checks;
      expect(jobs[check!.ci!]?.steps.map((step) => step.run)).toContain(
        [check!.executable, ...check!.argv].join(" "),
      );
    }),
  ));

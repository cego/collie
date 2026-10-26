import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

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

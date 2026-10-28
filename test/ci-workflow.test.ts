import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
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
).pipe(Effect.map((text) => Schema.decodeUnknownSync(workflowSchema)(Bun.YAML.parse(text))));

test("every CI job that checks the root installs Desktop's dependencies before it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { jobs } = yield* workflow;
      const checking = Object.values(jobs).filter((job) =>
        job.steps.some((step) => /^bun run (check|test)\b/.test(step.run ?? "")),
      );
      expect(checking.length).toBeGreaterThan(0);
      for (const { steps } of checking) {
        const rootInstall = steps.findIndex(
          (step) => step.run === "bun install --frozen-lockfile" && !step["working-directory"],
        );
        const desktopInstall = steps.findIndex(
          (step) =>
            step.run === "bun install --frozen-lockfile" && step["working-directory"] === "desktop",
        );
        const check = steps.findIndex((step) => /^bun run (check|test)\b/.test(step.run ?? ""));

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
      const runs = [gate?.needs ?? []]
        .flat()
        .flatMap((name) => jobs[name]?.steps.map((step) => step.run) ?? []);
      const { scripts } = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ check: Schema.String }) })),
      )(yield* fs.readFileString(`${root}/package.json`));
      const parts = scripts.check.split(" && ");
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts)
        expect(runs.some((run) => run === part || run?.startsWith(`${part} `))).toBe(true);
    }),
  ));

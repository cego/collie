import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { approvedFrom } from "../src/verify-spec";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const workflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
        steps: Schema.Array(
          Schema.Struct({
            run: Schema.optionalKey(Schema.String),
            "working-directory": Schema.optionalKey(Schema.String),
          }),
        ),
      }),
      Schema.Struct({
        needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
        uses: Schema.String,
      }),
    ]),
  ),
});

const workflow = (name: string) =>
  Effect.promise(() =>
    Bun.file(new URL(`../.github/workflows/${name}.yml`, import.meta.url)).text(),
  ).pipe(
    Effect.map((text) =>
      flow(Schema.decodeUnknownResult(workflowSchema), Result.getOrThrow)(Bun.YAML.parse(text)),
    ),
  );

const commands = (job: (typeof workflowSchema.Type.jobs)[string] | undefined) =>
  job !== undefined && "steps" in job
    ? Arr.flatMap(job.steps, (step) => (step.run === undefined ? [] : [step.run]))
    : [];

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

      const { jobs } = yield* workflow("ci");
      const gate = jobs[checks[0]!.ci!];
      const runs = Arr.flatMap([gate?.needs ?? []].flat(), (name) => commands(jobs[name]));
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

test("CI requires the same native desktop builds that the release publishes", () =>
  runEffect(
    Effect.gen(function* () {
      const ci = yield* workflow("ci");
      const release = yield* workflow("release");
      const native = yield* workflow("rune-bundle");
      for (const pipeline of [ci, release])
        expect(pipeline.jobs["desktop-native"]).toEqual({
          uses: "./.github/workflows/rune-bundle.yml",
        });
      for (const name of ["desktop", "desktop-rune", "desktop-native"]) {
        expect(ci.jobs.test?.needs).toContain(name);
        expect(Arr.join(commands(ci.jobs.test), "\n")).toContain(
          `test "\${{ needs.${name}.result }}" = success`,
        );
      }
      expect(release.jobs.release?.needs).toContain("desktop-native");
      for (const platform of ["linux", "macos"])
        expect(commands(native.jobs[platform])).toContain("bun run desktop-rune/scripts/bundle.ts");
      expect(commands(native.jobs.macos)).toContain("sh tools/verify-mac-app.sh desktop-rune/dist");
    }),
  ));

test("the required CI gate refuses each failed, cancelled or skipped dependency", () =>
  runEffect(
    Effect.gen(function* () {
      const ci = yield* workflow("ci");
      const gate = ci.jobs.test;
      const needs = [gate?.needs ?? []].flat();
      const script = Arr.join(commands(gate), "\n");
      const check = (failed: string | undefined, result: string) =>
        exec([
          "bash",
          "-e",
          "-c",
          Arr.reduce(needs, script, (text, name) =>
            pipe_(
              text,
              Str.replaceAll(`\${{ needs.${name}.result }}`, name === failed ? result : "success"),
            ),
          ),
        ]);
      expect((yield* check(undefined, "success")).exitCode).toBe(0);
      for (const name of needs)
        for (const result of ["failure", "cancelled", "skipped"])
          expect((yield* check(name, result)).exitCode).not.toBe(0);
    }),
  ));

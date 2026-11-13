import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
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

const Gated = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      if: Schema.optionalKey(Schema.String),
      uses: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Ruleset = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      parameters: Schema.optionalKey(
        Schema.Struct({
          required_status_checks: Schema.optionalKey(
            Schema.Array(Schema.Struct({ context: Schema.String })),
          ),
        }),
      ),
    }),
  ),
});

test("the merge queue's required check is the CI gate Collie's check is left to, run on every merge group", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = fileURLToPath(new URL("..", import.meta.url));
      const userDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-own-checks-" });
      const [check] = yield* approvedFrom({ cwd: root, userDir });
      const gated = (file: string) =>
        Effect.map(fs.readFileString(`${root}${file}`), (text) =>
          flow(Schema.decodeUnknownResult(Gated), Result.getOrThrow)(Bun.YAML.parse(text)),
        );
      const ruleset = yield* Schema.decodeEffect(Schema.fromJsonString(Ruleset))(
        yield* fs.readFileString(`${root}.github/rulesets/master.json`),
      ).pipe(Effect.orDie);
      const required = Arr.flatMap(ruleset.rules, (rule) =>
        Arr.map(rule.parameters?.required_status_checks ?? [], (one) => one.context),
      );
      expect(required).toEqual([check!.ci!]);
      expect(Arr.map(ruleset.rules, (rule) => rule.type)).toContain("merge_queue");

      const ci = yield* gated(".github/workflows/ci.yml");
      expect(Rec.keys(ci.on)).toContain("merge_group");
      const gate = ci.jobs[check!.ci!];
      for (const name of [gate?.needs ?? []].flat()) {
        const job = ci.jobs[name];
        expect({ name, if: job?.if }).toEqual({ name, if: undefined });
        if (job?.uses !== undefined)
          for (const [inner, called] of Rec.toEntries(
            (yield* gated(pipe_(job.uses, Str.replace(/^\.\//, "")))).jobs,
          ))
            expect({ name: `${name}/${inner}`, if: called.if }).toEqual({
              name: `${name}/${inner}`,
              if: undefined,
            });
      }
    }),
  ));

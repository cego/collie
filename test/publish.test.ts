import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Effect, FileSystem, Schema } from "effect";
import { proves, collie } from "./support/world";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges, PROJECT, FORGE_HOST } from "./support/forge";

const Started = Schema.Struct({ runId: Schema.String });

test.each(["github", "gitlab"] as const)(
  "%s publishing checks early pushes, then opens once and notes the existing request",
  (forge) =>
    proves(
      "collie-publish-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const git = (args: string[]) => exec(["git", ...args], { cwd: world.project });
          for (const args of [
            ["init", "-b", "main"],
            ["config", "user.name", "Tester"],
            ["config", "user.email", "test@example.com"],
            ["commit", "--allow-empty", "-m", "Initial"],
            ["update-ref", "refs/remotes/origin/main", "HEAD"],
            ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
            ["checkout", "-b", "fix/cache"],
            ["remote", "add", "origin", `https://${PROJECT[forge]}.git`],
            ["commit", "--allow-empty", "-m", "Keep cached results", "-m", "Built by this Run."],
          ])
            expect((yield* git(args)).exitCode).toBe(0);
          const sha = Str.trim((yield* git(["rev-parse", "--short", "HEAD"])).stdout);
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const real = Bun.which("git")!;
          yield* bin.add(
            "git",
            `if [ "$1" = push ]; then echo "$*" >> '${world.home}/pushes'; exit 0; fi\nexec '${real}' "$@"`,
          );
          const fake = yield* forgeOnPath(bin, forge, {
            installed: true,
            loggedIn: [FORGE_HOST[forge], "gitlab.cego.dk"],
            login: "mk",
            mrs: [],
          });
          const api = yield* serveForges(fake);
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=cache"], {
            COLLIE_FORGE_API: api,
            PATH: Bun.env.PATH!,
          });
          const { runId } = yield* Schema.decodeUnknownEffect(Started)(started.envelope.data);
          const file = `${world.home}/description.md`;
          yield* fs.writeFileString(file, "Retain results across reconnects.");
          const skipCiRefused = yield* collie(world, [
            "run",
            "publish",
            runId,
            "--file",
            file,
            "--skip-ci",
            "--request-id",
            "skip-ci-with-mr",
          ]);
          expect(skipCiRefused.envelope.error?.message).toContain("--skip-ci requires --push-only");
          const publish = (request: string, title = "Keep cached results") =>
            collie(world, [
              "run",
              "publish",
              runId,
              "--title",
              title,
              "--file",
              file,
              "--request-id",
              request,
            ]);
          const refused = yield* publish("leak");
          expect(refused.envelope.ok).toBe(false);
          expect(refused.envelope.error?.message).toContain(sha);
          expect(refused.envelope.error?.message).toContain("this Run");
          expect(yield* fs.exists(`${world.home}/pushes`)).toBe(false);
          expect((yield* fake.model()).mrs).toEqual([]);
          const push = (request: string) =>
            collie(world, [
              "run",
              "publish",
              runId,
              "--push-only",
              "--skip-ci",
              "--request-id",
              request,
            ]);
          const earlyRefused = yield* push("early-leak");
          expect(earlyRefused.envelope.ok).toBe(false);
          expect(earlyRefused.envelope.error?.message).toContain(sha);
          expect(earlyRefused.envelope.error?.message).toContain("this Run");
          expect(yield* fs.exists(`${world.home}/pushes`)).toBe(false);
          expect(
            (yield* git(["commit", "--amend", "--allow-empty", "-m", "Keep cached results"]))
              .exitCode,
          ).toBe(0);
          const earlyPushed = yield* push("early-clean");
          expect(earlyPushed.envelope).toMatchObject({ ok: true, data: { pushed: true } });
          expect((yield* push("early-clean")).envelope).toEqual(earlyPushed.envelope);
          expect((yield* fake.model()).mrs).toEqual([]);
          const earlyLine = `push -u origin HEAD${forge === "gitlab" ? " -o ci.skip" : ""}\n`;
          expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe(earlyLine);
          const opened = yield* publish("clean");
          expect(opened.envelope).toMatchObject({ ok: true });
          expect((yield* publish("clean")).envelope).toEqual(opened.envelope);
          expect((yield* fake.model()).mrs).toHaveLength(1);
          expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe(
            `${earlyLine}push -u origin HEAD\n`,
          );
          const shown = yield* collie(world, ["run", "show", runId]);
          const view = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ run: Schema.Struct({ mr: Schema.String }) }),
          )(shown.envelope.data);
          expect(view.run.mr).toBe(
            `https://${PROJECT[forge]}/${forge === "github" ? "pull" : "-/merge_requests"}/1`,
          );
          expect((yield* push("existing-push")).envelope.ok).toBe(true);
          expect(Arr.flatten(Rec.values((yield* fake.model()).notes ?? {}))).toEqual([]);
          yield* fs.writeFileString(file, "Also retain results after a timeout.");
          expect((yield* publish("note")).envelope.ok).toBe(true);
          const model = yield* fake.model();
          expect(model.mrs).toHaveLength(1);
          expect(Arr.flatten(Rec.values(model.notes ?? {}))).toEqual([
            `Also retain results after a timeout.\n\n<!-- collie:${runId} -->`,
          ]);
          expect((yield* git(["update-ref", "refs/remotes/origin/stable", "HEAD"])).exitCode).toBe(
            0,
          );
          expect(
            (yield* git([
              "commit",
              "--allow-empty",
              "-m",
              "Handle retries",
              "-m",
              "Verified by this Run.",
            ])).exitCode,
          ).toBe(0);
          expect((yield* git(["update-ref", "refs/remotes/origin/main", "HEAD"])).exitCode).toBe(0);
          yield* fake.set({
            ...model,
            mrs: Arr.map(model.mrs, (mr) => ({ ...mr, targetBranch: "stable" })),
          });
          expect((yield* publish("existing-target")).envelope.error?.message).toContain("this Run");
          expect(yield* fs.readFileString(`${world.home}/pushes`)).toBe(
            `${earlyLine}push -u origin HEAD\n${earlyLine}push -u origin HEAD\n`,
          );
        }),
      ["plain.workflow.ts"],
    ),
  60_000,
);

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { quietSkills } from "../src/skill-overrides";
import { mentionedSkills, skillMention } from "../src/template";
import { runEffect } from "./support/effect";

const skill = (dir: string, name: string, frontmatter = `name: ${name}`) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/${name}`, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/${name}/SKILL.md`,
      `---\n${frontmatter}\ndescription: A long description of ${name}.\n---\n\nBody.\n`,
    );
  });

const settings = (file: string, overrides: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(
      file,
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ skillOverrides: overrides }),
    );
  });

const command = (dir: string, name: string, markdown = "A long command description.") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${dir}/${name}.md`;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, markdown);
  });

const machine = Effect.gen(function* () {
  const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  return { claudeDir: `${root}/home/.claude`, cwd: `${root}/project` };
});

test("a user or project skill nobody named is listed by name only, and a named one as Claude has it", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* machine;
      yield* skill(`${where.claudeDir}/skills`, "tdd");
      yield* skill(`${where.claudeDir}/skills`, "kibana-dashboards");
      yield* skill(`${where.claudeDir}/skills`, "review-folder", "name: code-review");
      yield* skill(`${where.cwd}/.claude/skills`, "deploy");

      expect(yield* quietSkills(where, ["tdd", "code-review"])).toEqual({
        "kibana-dashboards": "name-only",
        deploy: "name-only",
      });
    }).pipe(Effect.scoped),
  ));

test("legacy command skills use file-based names and preserve required skills, operator choices and restrictions", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* machine;
      const user = `${where.claudeDir}/commands`;
      const project = `${where.cwd}/.claude/commands`;
      yield* fs.makeDirectory(`${where.cwd}/.git`, { recursive: true });
      yield* fs.makeDirectory(`${where.cwd}/packages/ui`, { recursive: true });
      yield* command(user, "release-check");
      yield* command(project, "frontend/component", "---\nname: ignored\n---\nBuild a component.");
      yield* command(`${where.cwd}/packages/ui/.claude/commands`, "ui-check");
      yield* fs.writeFileString(`${user}/notes.txt`, "Not a command.");
      for (const name of [
        "required",
        "frontend/required",
        "user-choice",
        "project-choice",
        "local-choice",
      ])
        yield* command(project, name);
      yield* settings(`${where.claudeDir}/settings.json`, { "user-choice": "off" });
      yield* settings(`${where.cwd}/.claude/settings.json`, { "project-choice": "on" });
      yield* settings(`${where.cwd}/.claude/settings.local.json`, {
        "local-choice": "user-invocable-only",
      });
      yield* command(user, "manual", "---\ndisable-model-invocation: true\n---\nManual only.");
      yield* command(project, "model-only", "---\nuser-invocable: false\n---\nModel only.");
      yield* command(project, "broken", "---\nname: [unclosed\n---\nBroken.");
      yield* skill(`${where.claudeDir}/skills`, "manual");
      yield* command(project, "shared");
      yield* skill(`${where.claudeDir}/skills`, "shared", "disable-model-invocation: true");

      expect(
        yield* quietSkills({ ...where, cwd: `${where.cwd}/packages/ui` }, [
          "required",
          "frontend:required",
        ]),
      ).toEqual({
        "release-check": "name-only",
        "frontend:component": "name-only",
        "ui-check": "name-only",
      });
    }).pipe(Effect.scoped),
  ));

test("a skill the operator's own user, project or local Claude settings decide is left to them", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* machine;
      for (const name of ["off-for-me", "on-in-project", "local-only", "noise"])
        yield* skill(`${where.claudeDir}/skills`, name);
      yield* settings(`${where.claudeDir}/settings.json`, { "off-for-me": "off" });
      yield* settings(`${where.cwd}/.claude/settings.json`, { "on-in-project": "on" });
      yield* settings(`${where.cwd}/.claude/settings.local.json`, { "local-only": "on" });

      expect(yield* quietSkills(where, [])).toEqual({ noise: "name-only" });
    }).pipe(Effect.scoped),
  ));

test("a skill Claude does not describe is not made more visible", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* machine;
      const dir = `${where.claudeDir}/skills`;
      yield* skill(dir, "manual", "name: manual\ndisable-model-invocation: true");
      yield* skill(dir, "model-only", "name: model-only\nuser-invocable: false");
      yield* skill(dir, "broken", "name: [unclosed");

      expect(yield* quietSkills(where, [])).toEqual({});
    }).pipe(Effect.scoped),
  ));

test("no skills directory is no overrides", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* quietSkills(yield* machine, [])).toEqual({});
    }).pipe(Effect.scoped),
  ));

test("outside a repository, an ancestor's skills are not treated as project skills", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* machine;
      yield* skill(`${where.cwd}/../.claude/skills`, "unrelated");
      expect(yield* quietSkills(where, [])).toEqual({});
    }).pipe(Effect.scoped),
  ));

test("a restricted skill stays restricted when another directory uses its name", () =>
  runEffect(
    Effect.gen(function* () {
      const where = yield* machine;
      yield* skill(`${where.claudeDir}/skills`, "shared");
      yield* skill(
        `${where.cwd}/.claude/skills`,
        "manual",
        "name: shared\ndisable-model-invocation: true",
      );
      expect(yield* quietSkills(where, [])).toEqual({});
    }).pipe(Effect.scoped),
  ));

test("a launch below the project root preserves root settings and discovers root skills", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* machine;
      yield* fs.makeDirectory(`${where.cwd}/.git`, { recursive: true });
      yield* fs.makeDirectory(`${where.cwd}/packages/ui`, { recursive: true });
      yield* skill(`${where.claudeDir}/skills`, "operator-choice");
      yield* skill(`${where.cwd}/.claude/skills`, "project-noise");
      yield* settings(`${where.cwd}/.claude/settings.json`, { "operator-choice": "off" });
      expect(yield* quietSkills({ ...where, cwd: `${where.cwd}/packages/ui` }, [])).toEqual({
        "project-noise": "name-only",
      });
    }).pipe(Effect.scoped),
  ));

test("a linked worktree preserves local settings from the main checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* machine;
      const main = `${where.cwd}-main`;
      yield* fs.makeDirectory(`${main}/.git/worktrees/task`, { recursive: true });
      yield* fs.makeDirectory(where.cwd, { recursive: true });
      yield* fs.writeFileString(`${where.cwd}/.git`, `gitdir: ${main}/.git/worktrees/task\n`);
      yield* fs.writeFileString(`${main}/.git/worktrees/task/commondir`, "../..\n");
      yield* settings(`${main}/.claude/settings.local.json`, { chosen: "off" });
      yield* skill(`${where.claudeDir}/skills`, "chosen");
      expect(yield* quietSkills(where, [])).toEqual({});
    }).pipe(Effect.scoped),
  ));

test.each([false, true])(
  "main-checkout skills are shortened only when Claude loads them (%s)",
  (mainCheckoutSkills) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const where = yield* machine;
        const main = `${where.cwd}-main`;
        yield* fs.makeDirectory(`${main}/.git/worktrees/task`, { recursive: true });
        yield* fs.makeDirectory(where.cwd, { recursive: true });
        yield* fs.writeFileString(`${where.cwd}/.git`, `gitdir: ${main}/.git/worktrees/task\n`);
        yield* fs.writeFileString(`${main}/.git/worktrees/task/commondir`, "../..\n");
        yield* skill(`${main}/.claude/skills`, "main-only");
        expect(yield* quietSkills({ ...where, mainCheckoutSkills }, [])).toEqual(
          mainCheckoutSkills ? { "main-only": "name-only" } : {},
        );
      }).pipe(Effect.scoped),
    ),
);

test("every skill a rendered persona or prompt mentions is found again, installed or not", () => {
  const render = skillMention(new Map([["tdd", "/home/me/.agents/skills/tdd/SKILL.md"]]));
  const text = `Use ${render("tdd")} and then ${render("to-spec")}; ${render("tdd")} again.`;
  expect(mentionedSkills(text)).toEqual(["tdd", "to-spec"]);
});

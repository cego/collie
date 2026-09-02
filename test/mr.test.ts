import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import {
  MR_TEMPLATE,
  addMrRole,
  parseMrUrl,
  gitlabForProject,
  gitlabReadiness,
  hostOf,
  linearIssues,
  mrFacts,
  mrTarget,
  parseMrTarget,
  projectFromRemote,
  repoArgs,
  resolveAssignee,
  templateFile,
} from "../src/mr";
import { Rig } from "./support/recorder";

let rig: Rig;

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const mkdir = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }));
const writeFile = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.close();
    }),
  ),
);

/** A scripted shell, so these tests never touch a real glab or git. */
function runner(table: Record<string, { code?: number; stdout?: string }>) {
  return (cmd: string, args: string[]) =>
    Effect.succeed(
      (() => {
        const key = `${cmd} ${args.join(" ")}`;
        const hit = table[key] ?? table[`${cmd} ${args[0]}`];
        return { code: hit?.code ?? (hit ? 0 : 1), stdout: hit?.stdout ?? "" };
      })(),
    );
}

test("GitLab is ready only with glab installed and a GitLab remote", () =>
  runEffect(
    Effect.gen(function* () {
      const ok = runner({
        "glab --version": { stdout: "glab 1.40" },
        "git remote -v": { stdout: "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)\n" },
      });
      expect(yield* gitlabReadiness(rig.projectDir, ok)).toEqual({ ok: true, reason: "" });

      const noGlab = runner({
        "git remote -v": { stdout: "origin\tgit@gitlab.cego.dk:x.git (fetch)\n" },
      });
      expect(yield* gitlabReadiness(rig.projectDir, noGlab)).toMatchObject({
        ok: false,
        reason: "glab is not installed",
      });

      const noRemote = runner({
        "glab --version": { stdout: "glab 1.40" },
        "git remote -v": { stdout: "" },
      });
      expect(yield* gitlabReadiness(rig.projectDir, noRemote)).toMatchObject({
        ok: false,
        reason: "this repo has no remote",
      });

      const elsewhere = runner({
        "glab --version": { stdout: "glab 1.40" },
        "git remote -v": { stdout: "origin\tgit@github.com:someone/x.git (fetch)\n" },
      });
      expect(yield* gitlabReadiness(rig.projectDir, elsewhere)).toMatchObject({
        ok: false,
        reason: "no GitLab remote",
      });
    }),
  ));

test("the assignee is the configured one, else whoever glab is logged in as", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = runner({ "glab api user": { stdout: '{"username": "mk", "name": "Mads"}' } });

      expect(yield* resolveAssignee(rig.projectDir, "someone-else", glab)).toBe("someone-else");
      expect(yield* resolveAssignee(rig.projectDir, "  ", glab)).toBe("mk");
      expect(yield* resolveAssignee(rig.projectDir, undefined, glab)).toBe("mk");
      // Not logged in, and nothing configured: say so rather than guess a username.
      expect(yield* resolveAssignee(rig.projectDir, undefined, runner({}))).toBeNull();
    }),
  ));

test("the repo's own MR template is found when it has one", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* templateFile(rig.projectDir)).toBeNull();
      yield* mkdir(join(rig.projectDir, ".gitlab", "merge_request_templates"));
      yield* writeFile(join(rig.projectDir, MR_TEMPLATE.replace(/\//g, "/")), "## Description\n");
      expect(yield* templateFile(rig.projectDir)).toBe(MR_TEMPLATE);
    }),
  ));

test("Linear ids come from the work source, the branch and the plan run, deduplicated", () =>
  runEffect(
    Effect.gen(function* () {
      const runDir = join(rig.stateDir, "runs", "plan-linear");
      yield* mkdir(runDir);
      yield* writeFile(join(runDir, "run.json"), "{}\n");
      const choice = join(runDir, "steps", "next", "offload-to-linear-1");
      yield* mkdir(choice);
      yield* writeFile(join(choice, "next.json"), `{"verdict":"clean","issue":"ENG-42","url":"u"}`);
      const planDir = join(runDir, "plan");

      const git = runner({
        "git rev-parse --abbrev-ref HEAD": { stdout: "feature/FRO-149-modal\n" },
      });

      // A plan dir contributes what the plan offloaded; the branch contributes its own.
      expect(
        yield* linearIssues(
          { cwd: rig.projectDir, inputs: { plan: planDir, plan_kind: "plan-dir" } },
          git,
        ),
      ).toEqual(["FRO-149", "ENG-42"]);

      // A linear work source contributes itself, and is not repeated by the branch.
      expect(
        yield* linearIssues(
          { cwd: rig.projectDir, inputs: { plan: "FRO-149", plan_kind: "linear" } },
          git,
        ),
      ).toEqual(["FRO-149"]);

      // Free text names no ticket, so only the branch does.
      expect(
        yield* linearIssues(
          { cwd: rig.projectDir, inputs: { plan: "make it nicer", plan_kind: "text" } },
          git,
        ),
      ).toEqual(["FRO-149"]);
    }),
  ));

test("a branch with no ticket and a plan that offloaded nothing yields no ids", () =>
  runEffect(
    Effect.gen(function* () {
      const git = runner({ "git rev-parse --abbrev-ref HEAD": { stdout: "add-a-picker\n" } });
      expect(yield* linearIssues({ cwd: rig.projectDir, inputs: {} }, git)).toEqual([]);
    }),
  ));

test("mrFacts gathers the three things the prompt needs in one go", () =>
  runEffect(
    Effect.gen(function* () {
      const run = runner({
        "glab api user": { stdout: '{"username": "mk"}' },
        "git rev-parse --abbrev-ref HEAD": { stdout: "FRO-149-modal\n" },
      });

      expect(yield* mrFacts({ cwd: rig.projectDir, inputs: {} }, run)).toEqual({
        assignee: "mk",
        template: null,
        issues: ["FRO-149"],
      });
    }),
  ));

test("an MR url names its project and iid, and a role is added rather than replaced", () =>
  runEffect(
    Effect.gen(function* () {
      const mr = parseMrUrl("https://gitlab.cego.dk/cego/sub/deep/-/merge_requests/7\n");
      expect(mr).toEqual({ project: "gitlab.cego.dk/cego/sub/deep", iid: "7" });
      expect(parseMrUrl("https://gitlab.cego.dk/cego/x")).toBeNull();

      const seen: string[][] = [];
      const run = (_cmd: string, args: string[]) => {
        seen.push(args);
        return Effect.succeed({ code: 0, stdout: "" });
      };
      yield* addMrRole(mr!, "reviewer", "mk", "/x", run);
      yield* addMrRole({ project: null, iid: "3" }, "assignee", "mk", "/x", run);
      // `+` keeps whoever is on the merge request already.
      expect(seen).toEqual([
        ["mr", "update", "7", "--repo", "gitlab.cego.dk/cego/sub/deep", "--reviewer", "+mk"],
        ["mr", "update", "3", "--assignee", "+mk"],
      ]);
    }),
  ));

test("an MR target carries host, group and project, and reads back", () => {
  expect(mrTarget("gitlab.cego.dk/cego/herdr-plugin", "42")).toBe(
    "mr:gitlab.cego.dk/cego/herdr-plugin!42",
  );
  expect(parseMrTarget("mr:gitlab.cego.dk/cego/herdr-plugin!42")).toEqual({
    project: "gitlab.cego.dk/cego/herdr-plugin",
    iid: "42",
  });
  // The shape that came before, still understood: an iid in whatever repo you are in.
  expect(mrTarget(null, "42")).toBe("mr:42");
  expect(parseMrTarget("mr:42")).toEqual({ project: null, iid: "42" });
  // Anything that is not an MR target, and anything malformed, is not one.
  expect(parseMrTarget("worktree")).toBeNull();
  expect(parseMrTarget("branch:main...x")).toBeNull();
  expect(parseMrTarget("mr:cego/x!")).toBeNull();
  expect(parseMrTarget("mr:cego/x")).toBeNull();

  expect(repoArgs("cego/x")).toEqual(["--repo", "cego/x"]);
  expect(repoArgs(null)).toEqual([]);
  expect(hostOf("gitlab.cego.dk/cego/x")).toBe("gitlab.cego.dk");
  expect(hostOf("cego/x")).toBeNull();
  expect(hostOf(null)).toBeNull();
});

test("a project is read out of either remote shape", () => {
  const want = "gitlab.cego.dk/cego/herdr-plugin";
  expect(projectFromRemote("git@gitlab.cego.dk:cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("https://gitlab.cego.dk/cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("https://gitlab.cego.dk/cego/herdr-plugin")).toBe(want);
  expect(projectFromRemote("ssh://git@gitlab.cego.dk/cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("git@gitlab.cego.dk:cego/sub/deep.git")).toBe(
    "gitlab.cego.dk/cego/sub/deep",
  );
  // Not a remote this plugin can name a project from.
  expect(projectFromRemote("")).toBeNull();
  expect(projectFromRemote("/srv/git/bare.git")).toBeNull();
});

test("a step pointed at a project needs glab logged in to that host, not a checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const calls: string[][] = [];
      const run = (cmd: string, args: string[]) =>
        Effect.succeed(
          (() => {
            calls.push([cmd, ...args]);
            if (cmd === "glab" && args[0] === "--version") return { code: 0, stdout: "glab 1.0" };
            if (cmd === "glab" && args[0] === "auth") return { code: 0, stdout: "logged in" };
            // No git remotes here at all: the point is that it is never asked.
            return { code: 1, stdout: "" };
          })(),
        );

      const ready = yield* gitlabForProject("gitlab.cego.dk/cego/x", "/not/a/repo", run);

      expect(ready.ok).toBe(true);
      expect(calls).toEqual([
        ["glab", "--version"],
        ["glab", "auth", "status", "--hostname", "gitlab.cego.dk"],
      ]);
    }),
  ));

test("not logged in to that host says so, and no project falls back to the checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const run = (cmd: string, args: string[]) =>
        Effect.succeed(
          (() => {
            if (cmd === "glab" && args[0] === "--version") return { code: 0, stdout: "glab 1.0" };
            if (cmd === "glab" && args[0] === "auth") return { code: 1, stdout: "" };
            return { code: 1, stdout: "" };
          })(),
        );

      expect((yield* gitlabForProject("gitlab.cego.dk/cego/x", "/x", run)).reason).toBe(
        "glab is not logged in to gitlab.cego.dk",
      );
      // A target with no project can only be judged by the directory, as before.
      expect((yield* gitlabForProject(null, "/x", run)).reason).toBe("this repo has no remote");
    }),
  ));

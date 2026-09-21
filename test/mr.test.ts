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
  mrDetails,
  mrFacts,
  mrTarget,
  parseMrTarget,
  projectFromRemote,
  repoArgs,
  resolveAssignee,
  sinceReview,
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
          {
            cwd: rig.projectDir,
            inputs: { plan: planDir, plan_kind: "plan-dir" },
            strategies: { plan: "work-source" },
          },
          git,
        ),
      ).toEqual(["FRO-149", "ENG-42"]);

      // A linear work source contributes itself, and is not repeated by the branch.
      expect(
        yield* linearIssues(
          {
            cwd: rig.projectDir,
            inputs: { plan: "FRO-149", plan_kind: "linear" },
            strategies: { plan: "work-source" },
          },
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

/** Every field a GitLab version or a token might not answer, nulled rather than absent. */
const ALL_NULL = `{
  "iid": 9,
  "title": null,
  "state": null,
  "author": null,
  "source_branch": null,
  "target_branch": null,
  "sha": null,
  "updated_at": null,
  "web_url": null,
  "head_pipeline": null,
  "pipeline": null,
  "blocking_discussions_resolved": null,
  "user_notes_count": null,
  "approvals_required": null,
  "approvals_left": null
}`;

const MR_JSON = JSON.stringify({
  iid: 42,
  title: "Make the tab an application",
  state: "opened",
  draft: false,
  author: { username: "mk" },
  source_branch: "collie-app",
  target_branch: "master",
  sha: "0123456789abcdef0123456789abcdef01234567",
  updated_at: "2026-09-02T11:00:00.000Z",
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/42",
  head_pipeline: { status: "success" },
  blocking_discussions_resolved: false,
  user_notes_count: 7,
  approvals_required: 2,
  approvals_left: 1,
});

/** A recording runner, so a test can count what was asked of glab as well as read it. */
function recorder(table: Record<string, { code?: number; stdout?: string }>) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(" ")}`;
    const hit = table[key] ?? table[`${cmd} ${args[0]}`];
    return Effect.succeed({ code: hit?.code ?? (hit ? 0 : 1), stdout: hit?.stdout ?? "" });
  };
  return { run, calls };
}

const READY = {
  "glab --version": { stdout: "glab 1.40" },
  "glab auth status --hostname gitlab.example.com": { stdout: "logged in" },
};

test("a merge request answers the whole panel in one view call", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        "glab mr view 42 --repo gitlab.example.com/g/p -F json": { stdout: MR_JSON },
      });

      const details = yield* mrDetails(
        { project: "gitlab.example.com/g/p", iid: "42" },
        "/w/p",
        glab.run,
      );

      expect(details._tag).toBe("Details");
      if (details._tag !== "Details") return;
      expect(details.iid).toBe("42");
      expect(details.title).toBe("Make the tab an application");
      expect(details.state).toBe("opened");
      expect(details.author).toBe("mk");
      expect(details.sourceBranch).toBe("collie-app");
      expect(details.targetBranch).toBe("master");
      expect(details.pipeline).toBe("success");
      expect(details.approvals).toBe("1 of 2 still needed");
      expect(details.unresolved).toBe(true);
      expect(details.notes).toBe(7);
      // Short enough to read, long enough to tell two heads apart.
      expect(details.headSha).toBe("0123456");
      expect(details.updatedAt).toBe(Date.parse("2026-09-02T11:00:00.000Z"));
      expect(details.url).toBe("https://gitlab.example.com/g/p/-/merge_requests/42");

      // One call for the panel; the readiness probes are what precede it.
      expect(glab.calls.filter((c) => c[1] === "mr")).toHaveLength(1);
    }),
  ));

test("no glab, no login and a dead merge request each come back as one stated line", () =>
  runEffect(
    Effect.gen(function* () {
      const ref = { project: "gitlab.example.com/g/p", iid: "42" };

      const noGlab = yield* mrDetails(ref, "/w/p", recorder({}).run);
      expect(noGlab).toEqual({ _tag: "Unavailable", reason: "glab is not installed" });

      const loggedOut = yield* mrDetails(
        ref,
        "/w/p",
        recorder({ "glab --version": { stdout: "glab 1.40" } }).run,
      );
      expect(loggedOut).toEqual({
        _tag: "Unavailable",
        reason: "glab is not logged in to gitlab.example.com",
      });

      // Ready, but glab cannot answer about this merge request.
      const gone = yield* mrDetails(
        ref,
        "/w/p",
        recorder({ ...READY, "glab mr view 42 --repo gitlab.example.com/g/p -F json": { code: 1 } })
          .run,
      );
      expect(gone).toEqual({
        _tag: "Unavailable",
        reason: "glab could not read gitlab.example.com/g/p!42",
      });

      // Ready and answering, with something that is not a merge request.
      const nonsense = yield* mrDetails(
        ref,
        "/w/p",
        recorder({
          ...READY,
          "glab mr view 42 --repo gitlab.example.com/g/p -F json": { stdout: "<html>login</html>" },
        }).run,
      );
      expect(nonsense).toEqual({
        _tag: "Unavailable",
        reason: `what glab said about gitlab.example.com/g/p!42 is not a merge request`,
      });
    }),
  ));

test("a merge request that has not moved since a review says so, and one that has", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        "glab mr view 42 --repo gitlab.example.com/g/p -F json": { stdout: MR_JSON },
      });
      const details = yield* mrDetails(
        { project: "gitlab.example.com/g/p", iid: "42" },
        "/w/p",
        glab.run,
      );
      if (details._tag !== "Details") throw new Error("expected details");

      // The review finished after the last change: nothing has moved, stop looking.
      expect(sinceReview(details, Date.parse("2026-09-02T12:00:00.000Z"))).toBe(
        "nothing has moved since this review",
      );
      // The review finished before it: they have pushed, review again.
      expect(sinceReview(details, Date.parse("2026-09-02T09:00:00.000Z"))).toBe(
        "changed 2h after this review — head 0123456",
      );
      // No review to compare against.
      expect(sinceReview(details, 0)).toBe("");
    }),
  ));

test("a real merge request decodes, nulls and absent approvals and all", () =>
  runEffect(
    Effect.gen(function* () {
      // Captured verbatim from `glab mr view 17 --repo … -F json` against a live GitLab,
      // trimmed to the fields the panel reads. `"pipeline": null` is what a merge request
      // with no second pipeline actually sends: a schema that allowed the key to be
      // omitted but not null rejected it, and the panel reported a merge request it had
      // just read as "not a merge request".
      const fs = yield* FileSystem.FileSystem;
      const real = yield* fs.readFileString("test/support/mr-view.json");
      const glab = recorder({
        ...READY,
        "glab mr view 17 --repo gitlab.example.com/g/p -F json": { stdout: real },
      });

      const details = yield* mrDetails(
        { project: "gitlab.example.com/g/p", iid: "17" },
        "/w/p",
        glab.run,
      );

      expect(details._tag).toBe("Details");
      if (details._tag !== "Details") return;
      expect(details.iid).toBe("17");
      expect(details.state).toBe("opened");
      expect(details.author).toBe("mk");
      expect(details.sourceBranch).toBe("collie-app");
      // `head_pipeline` answers even though `pipeline` is null.
      expect(details.pipeline).toBe("skipped");
      expect(details.unresolved).toBe(false);
      // Approvals are not on the merge-request object here, so the panel says nothing
      // about them rather than claiming none are needed.
      expect(details.approvals).toBe("");
      expect(details.headSha).toBe("a40caaf");
    }),
  ));

test("a required-but-unknown approval count says what is required, not that none approved", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        "glab mr view 8 --repo gitlab.example.com/g/p -F json": {
          stdout: `{ "iid": 8, "approvals_required": 2 }`,
        },
      });

      const details = yield* mrDetails(
        { project: "gitlab.example.com/g/p", iid: "8" },
        "/w/p",
        glab.run,
      );

      if (details._tag !== "Details") throw new Error("expected details");
      // How many are left is what this GitLab did not answer; "2 of 2 still needed"
      // would assert nobody has approved, which the input does not say.
      expect(details.approvals).toBe("2 approval(s) required");
    }),
  ));

test("a null where a value could have been is the same as no value", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        "glab mr view 9 --repo gitlab.example.com/g/p -F json": { stdout: ALL_NULL },
      });

      const details = yield* mrDetails(
        { project: "gitlab.example.com/g/p", iid: "9" },
        "/w/p",
        glab.run,
      );

      // Every one of them nulled: the panel renders a merge request it knows little
      // about rather than refusing to render one at all.
      expect(details._tag).toBe("Details");
      if (details._tag !== "Details") return;
      expect(details.iid).toBe("9");
      expect(details.title).toBe("");
      expect(details.pipeline).toBe("");
      expect(details.approvals).toBe("");
      expect(details.unresolved).toBe(false);
      expect(details.updatedAt).toBe(0);
    }),
  ));

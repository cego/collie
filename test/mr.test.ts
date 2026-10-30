import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { forgeOfHost } from "../src/forge/forge";
import {
  fakeForge,
  forgeHttpOver,
  CLI,
  FORGE_HOST,
  PROJECT,
  type ForgeModel,
} from "./support/forge";
import {
  autoMergingHere,
  forgeHere,
  prepareMergeRequest,
  linearIssues,
  mrTarget,
  postNote,
  projectFromRemote,
  resolveAssignee,
  shell,
  sinceReview,
  whatItSaid,
} from "../src/mr";
import { parseMrUrl, parseMrTarget } from "../src/board-model";
import { gitlab, gitlabForProject, hostOf, mrDetails, repoArgs } from "../src/forge/gitlab";
import { Rig } from "./support/recorder";
import { epochMs } from "../src/time";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** A scripted shell, so these tests never touch a real glab or git. */
function runner(table: Record<string, { code?: number; stdout?: string }>) {
  return (cmd: string, args: string[]) =>
    Effect.succeed(
      (() => {
        const key = `${cmd} ${Arr.join(args, " ")}`;
        const hit = table[key] ?? table[`${cmd} ${args[0]}`];
        return { code: hit?.code ?? (hit ? 0 : 1), stdout: hit?.stdout ?? "" };
      })(),
    );
}

test("a host's forge is GitHub on github.com, GitLab on the Flock's GitLab or a gitlab host, else none", () => {
  expect(forgeOfHost("github.com")).toBe("github");
  expect(forgeOfHost("gitlab.cego.dk")).toBe("gitlab");
  expect(forgeOfHost("gitlab.example.com")).toBe("gitlab");
  expect(forgeOfHost("code.example.com", "code.example.com")).toBe("gitlab");
  expect(forgeOfHost("code.example.com")).toBeNull();
  expect(forgeOfHost("bitbucket.org", "gitlab.cego.dk")).toBeNull();
});

test("a checkout's forge is its origin's, else its upstream's, whatever else it has", () =>
  runEffect(
    Effect.gen(function* () {
      const here = (table: Record<string, { stdout?: string }>) =>
        Effect.map(forgeHere("/w", runner(table)), (found) =>
          found.ok ? [found.forge.name, found.project] : found.reason,
        );
      // cego/collie: a GitHub origin beside an old gitlab remote is GitHub.
      expect(
        yield* here({
          "git remote get-url origin": { stdout: "git@github.com:cego/collie.git\n" },
          "git remote get-url gitlab": { stdout: "git@gitlab.cego.dk:mk/collie.git\n" },
        }),
      ).toEqual(["github", "github.com/cego/collie"]);
      expect(
        yield* here({
          "git remote get-url upstream": { stdout: "https://gitlab.cego.dk/cego/x.git" },
        }),
      ).toEqual(["gitlab", "gitlab.cego.dk/cego/x"]);
      expect(yield* here({})).toBe("this repo has no remote");
      expect(
        yield* here({ "git remote get-url origin": { stdout: "git@bitbucket.org:a/b.git" } }),
      ).toBe("bitbucket.org is neither GitHub nor GitLab");
    }),
  ));

test("the assignee is the configured one, else whoever the forge's CLI is logged in as", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = fakeForge("gitlab", {
        installed: true,
        loggedIn: [FORGE_HOST.gitlab],
        login: "mk",
        mrs: [],
      });
      const ask = (configured: string | undefined, fake: typeof glab) =>
        resolveAssignee(rig.projectDir, configured, gitlab, fake.run, PROJECT.gitlab).pipe(
          Effect.provide(fake.layer),
        );
      expect(yield* ask("someone-else", glab)).toBe("someone-else");
      expect(yield* ask("  ", glab)).toBe("mk");
      expect(yield* ask(undefined, glab)).toBe("mk");
      // Not logged in, and nothing configured: say so rather than guess a username.
      expect(
        yield* ask(
          undefined,
          fakeForge("gitlab", { installed: true, loggedIn: [], login: null, mrs: [] }),
        ),
      ).toBeNull();
    }),
  ));

test("Linear ids come from the work source and the branch, deduplicated", () =>
  runEffect(
    Effect.gen(function* () {
      const git = runner({
        "git rev-parse --abbrev-ref HEAD": { stdout: "feature/FRO-149-modal\n" },
      });

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

test("a branch with no ticket and a work source with none yields no ids", () =>
  runEffect(
    Effect.gen(function* () {
      const git = runner({ "git rev-parse --abbrev-ref HEAD": { stdout: "add-a-picker\n" } });
      expect(yield* linearIssues({ cwd: rig.projectDir, inputs: {} }, git)).toEqual([]);
    }),
  ));

const ORIGIN = {
  gitlab: "git@gitlab.example.com:group/app.git",
  github: "git@github.com:owner/repo.git",
};

for (const name of ["gitlab", "github"] as const) {
  const checkout = (over: Partial<ForgeModel> = {}): ForgeModel => ({
    installed: true,
    loggedIn: [FORGE_HOST[name]],
    login: "me",
    origin: ORIGIN[name],
    branch: "me/FRO-149-modal",
    mrs: [{ project: PROJECT[name], iid: "30", state: "closed" }],
    ...over,
  });
  const prepare = (model: ForgeModel, assignees = {}) => {
    const fake = fakeForge(name, model);
    return prepareMergeRequest({ cwd: rig.projectDir, assignees }, fake.run).pipe(
      Effect.provide(fake.layer),
    );
  };

  test(`a merge request from a ${name} checkout is that forge's, with its login, template and commands`, () =>
    runEffect(
      Effect.gen(function* () {
        // The other forge's configured assignee never answers for this one.
        const other = name === "gitlab" ? "github" : "gitlab";
        const ready = yield* prepare(checkout(), { [other]: "someone-else" });
        expect(ready).toMatchObject({
          ok: true,
          provider: name,
          forge: name === "gitlab" ? "GitLab" : "GitHub",
          noun: name === "gitlab" ? "merge request" : "pull request",
          assignee: "me",
          template: "",
          issues: ["FRO-149"],
          existing: "",
          autoMerge: false,
          branch: "me/FRO-149-modal",
          url:
            name === "gitlab"
              ? "https://gitlab.example.com/group/app"
              : "https://github.com/owner/repo",
        });
        expect(ready.commands?.create).toContain(`${CLI[name]} `);
        expect(ready.commands?.create).toContain("--assignee me ");
        expect(ready.commands?.comment).toBe("");
        expect((yield* prepare(checkout(), { [name]: "lander" })).assignee).toBe("lander");
      }),
    ));

  test(`a ${name} branch's open merge request is the one to update, auto-merge and all`, () =>
    runEffect(
      Effect.gen(function* () {
        const open = {
          project: PROJECT[name],
          iid: "31",
          state: "open",
          sourceBranch: "me/FRO-149-modal",
        } as const;
        const ready = yield* prepare(checkout({ mrs: [{ ...open, autoMerge: true }] }));
        expect(ready.existing).toContain("31");
        expect(ready.autoMerge).toBe(true);
        expect(ready.commands?.comment).toContain(`${CLI[name]} `);
        expect(ready.commands?.comment).toContain("31");
      }),
    ));

  test(`a ${name} checkout with no CLI, no login, or no forge cannot open one, and says why`, () =>
    runEffect(
      Effect.gen(function* () {
        expect((yield* prepare(checkout({ installed: false }))).reason).toBe(
          `${CLI[name]} is not installed`,
        );
        expect((yield* prepare(checkout({ loggedIn: [] }))).reason).toBe(
          `${CLI[name]} is not logged in to ${FORGE_HOST[name]}`,
        );
        expect(yield* prepare(checkout({ origin: "git@bitbucket.org:a/b.git" }))).toMatchObject({
          ok: false,
          reason: "bitbucket.org is neither GitHub nor GitLab",
        });
      }),
    ));
}

test("an MR url names its project and iid", () => {
  expect(parseMrUrl("https://gitlab.cego.dk/cego/sub/deep/-/merge_requests/7\n")).toEqual({
    project: "gitlab.cego.dk/cego/sub/deep",
    iid: "7",
  });
  expect(parseMrUrl("https://gitlab.cego.dk/cego/x")).toBeNull();
});

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

test("not logged in to that host says so, and no project leaves the checkout to detection", () =>
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
      // A target with no project is judged by its checkout's forge, before the adapter is asked.
      expect(yield* gitlabForProject(null, "/x", run)).toEqual({ ok: true, reason: "" });
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
    const key = `${cmd} ${Arr.join(args, " ")}`;
    const hit = table[key] ?? table[`${cmd} ${args[0]}`];
    return Effect.succeed({ code: hit?.code ?? (hit ? 0 : 1), stdout: hit?.stdout ?? "" });
  };
  return { run, calls };
}

/** glab logged in to gitlab.example.com, as ForgeHttp reads its token. */
const READY = { "glab config get token --host gitlab.example.com": { stdout: "glpat-test\n" } };

/** The request for merge request `iid` of g/p, as `glab api` is asked it. */
const viewOf = (iid: string, host = "gitlab.example.com") =>
  `glab api --hostname ${host} -X GET projects/g%2Fp/merge_requests/${iid}`;

/** `mrDetails`, its requests answered as the recorded glab answers their routes. */
const detailsOver = (ref: { project: string; iid: string }, glab: ReturnType<typeof recorder>) =>
  mrDetails(ref, "/w/p", glab.run).pipe(Effect.provide(forgeHttpOver(glab.run)));

test("a merge request answers the whole panel from one read of it", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        [viewOf("42")]: { stdout: MR_JSON },
      });

      const details = yield* detailsOver({ project: "gitlab.example.com/g/p", iid: "42" }, glab);

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
      expect(details.updatedAt).toBe(epochMs("2026-09-02T11:00:00.000Z"));
      expect(details.url).toBe("https://gitlab.example.com/g/p/-/merge_requests/42");

      // One read of the merge request itself; its approvals and discussions are others.
      expect(Arr.filter(glab.calls, (c) => Arr.join(c, " ") === viewOf("42"))).toHaveLength(1);
    }),
  ));

test("no login and a dead merge request each come back as one stated line", () =>
  runEffect(
    Effect.gen(function* () {
      const ref = { project: "gitlab.example.com/g/p", iid: "42" };

      // No glab and a glab logged out alike hold no token for the host.
      expect(yield* detailsOver(ref, recorder({}))).toEqual({
        _tag: "Unavailable",
        reason:
          "could not read gitlab.example.com/g/p!42: glab is not logged in to gitlab.example.com",
      });

      // Logged in, but GitLab cannot answer about this merge request.
      expect(yield* detailsOver(ref, recorder({ ...READY, [viewOf("42")]: { code: 1 } }))).toEqual({
        _tag: "Unavailable",
        reason: "could not read gitlab.example.com/g/p!42: GitLab answered 404: 404",
      });

      // Answering, with something that is not a merge request.
      expect(
        yield* detailsOver(ref, recorder({ ...READY, [viewOf("42")]: { stdout: "[]" } })),
      ).toEqual({
        _tag: "Unavailable",
        reason:
          "could not read gitlab.example.com/g/p!42: GitLab answered projects/g%2Fp/merge_requests/42 in a shape Collie does not read",
      });
    }),
  ));

test("a merge request that has not moved since a review says so, and one that has", () =>
  runEffect(
    Effect.gen(function* () {
      const glab = recorder({
        ...READY,
        [viewOf("42")]: { stdout: MR_JSON },
      });
      const details = yield* detailsOver({ project: "gitlab.example.com/g/p", iid: "42" }, glab);
      if (details._tag !== "Details") throw new Error("expected details");

      // The review finished after the last change: nothing has moved, stop looking.
      expect(sinceReview(details, epochMs("2026-09-02T12:00:00.000Z"))).toBe(
        "nothing has moved since this review",
      );
      // The review finished before it: they have pushed, review again.
      expect(sinceReview(details, epochMs("2026-09-02T09:00:00.000Z"))).toBe(
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
        [viewOf("17")]: { stdout: real },
      });

      const details = yield* detailsOver({ project: "gitlab.example.com/g/p", iid: "17" }, glab);

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
        [viewOf("8")]: {
          stdout: `{ "iid": 8, "approvals_required": 2 }`,
        },
      });

      const details = yield* detailsOver({ project: "gitlab.example.com/g/p", iid: "8" }, glab);

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
        [viewOf("9")]: { stdout: ALL_NULL },
      });

      const details = yield* detailsOver({ project: "gitlab.example.com/g/p", iid: "9" }, glab);

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

test("a pipeline's status is read from GitLab by its address", () => {
  const fake = fakeForge("gitlab", {
    installed: true,
    loggedIn: ["gitlab.example.com"],
    login: "me",
    mrs: [],
    runs: { "77": { status: "failed" } },
  });
  return runEffect(
    Effect.gen(function* () {
      const status = (url: string) => gitlab.runStatus(url, "/w", fake.run);
      expect(yield* status("https://gitlab.example.com/g/p/-/pipelines/77")).toBe("failed");
      expect(yield* status("https://gitlab.example.com/g/p/-/pipelines/77/failures")).toBe(
        "failed",
      );
      // Not answered, or not a pipeline at all: nothing to say.
      expect(yield* status("https://gitlab.example.com/g/p/-/pipelines/78")).toBeNull();
      expect(yield* status("https://gitlab.example.com/g/p/-/merge_requests/1")).toBeNull();
      expect(Arr.map(fake.requests, (one) => one.url)).toEqual([
        "https://gitlab.example.com/api/v4/projects/g%2Fp/pipelines/77",
        "https://gitlab.example.com/api/v4/projects/g%2Fp/pipelines/77",
        "https://gitlab.example.com/api/v4/projects/g%2Fp/pipelines/78",
      ]);
    }).pipe(Effect.provide(fake.layer)),
  );
});

test("a command's answer is its stdout, and a human is told both streams", () =>
  runEffect(
    Effect.gen(function* () {
      const ran = yield* shell("sh", ["-c", "echo answer; echo warning >&2; exit 3"], rig.root);

      expect(ran).toEqual({ code: 3, stdout: "answer\n", stderr: "warning\n" });
      expect(whatItSaid(ran)).toBe("answer\nwarning");
    }),
  ));

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} merge request assigned to whoever posts is theirs to fix, so nothing is posted`, () =>
    runEffect(
      Effect.gen(function* () {
        const fake = fakeForge(name, {
          installed: true,
          loggedIn: [FORGE_HOST[name]],
          login: "me",
          mrs: [{ project: PROJECT[name], iid: "30", state: "open", assignees: ["me"] }],
        });
        const target = mrTarget(PROJECT[name], "30");
        const posted = yield* postNote(
          { target, cwd: "/w", body: "LGTM", approve: true },
          fake.run,
        ).pipe(Effect.provide(fake.layer));
        expect(posted).toEqual({
          ok: false,
          message: `${target} is assigned to you, so its findings are yours to fix rather than to post`,
        });
        expect(fake.model().notes ?? {}).toEqual({});
      }),
    ));
}

test("posting checks the login on the target's GitLab host", () =>
  runEffect(
    Effect.gen(function* () {
      const target = "mr:gitlab.other.com/g/p!42";
      const glab = recorder({
        "glab --version": { stdout: "glab" },
        "glab auth status --hostname gitlab.other.com": { stdout: "logged in" },
        "glab config get token --host gitlab.other.com": { stdout: "glpat-other\n" },
        "glab api --hostname gitlab.other.com -X GET user": {
          stdout: '{"id":1,"username":"other-me"}',
        },
        [viewOf("42", "gitlab.other.com")]: {
          stdout: '{"state":"opened","assignees":[{"username":"other-me"}]}',
        },
        "glab mr": { stdout: "" },
      });
      expect(
        yield* postNote({ target, cwd: "/w", body: "LGTM", approve: true }, glab.run).pipe(
          Effect.provide(forgeHttpOver(glab.run)),
        ),
      ).toEqual({
        ok: false,
        message: `${target} is assigned to you, so its findings are yours to fix rather than to post`,
      });
      expect(Arr.some(glab.calls, (call) => call[2] === "note" || call[2] === "approve")).toBe(
        false,
      );
    }),
  ));

test("a legacy bare merge request never becomes a GitHub pull request", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge("github", {
        installed: true,
        loggedIn: ["github.com"],
        login: "me",
        origin: "git@github.com:owner/repo.git",
        mrs: [{ project: "github.com/owner/repo", iid: "42", state: "open" }],
      });
      const reason = "mr:42 is a GitLab target, but this checkout is on GitHub";
      expect(
        yield* postNote({ target: "mr:42", cwd: "/w", body: "LGTM" }, fake.run).pipe(
          Effect.provide(fake.layer),
        ),
      ).toEqual({ ok: false, message: reason });
      expect(
        yield* prepareMergeRequest({ target: "mr:42", cwd: rig.projectDir }, fake.run).pipe(
          Effect.provide(fake.layer),
        ),
      ).toMatchObject({ ok: false, reason });
      expect(fake.model().notes ?? {}).toEqual({});
    }),
  ));

test("a bare !42 is posted on the Flock's GitLab even where its name does not say gitlab", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge("gitlab", {
        installed: true,
        loggedIn: ["code.example.com"],
        login: "me",
        origin: "git@code.example.com:group/app.git",
        mrs: [{ project: "code.example.com/group/app", iid: "42", state: "open" }],
      });
      const post = (options: { readonly gitlabHost?: string }) =>
        postNote({ target: "mr:42", cwd: "/w", body: "LGTM", ...options }, fake.run).pipe(
          Effect.provide(fake.layer),
        );
      expect((yield* post({})).message).toBe("code.example.com is neither GitHub nor GitLab");
      expect((yield* post({ gitlabHost: "code.example.com" })).ok).toBe(true);
    }),
  ));

test("whether a branch's merge request merges itself is unknown, not no, where its forge cannot say", () =>
  runEffect(
    Effect.gen(function* () {
      const asked = (listed: { code?: number; stdout?: string }) => {
        const run = runner({
          "git remote get-url origin": { stdout: "git@gitlab.example.com:group/app.git\n" },
          "git rev-parse --abbrev-ref HEAD": { stdout: "feature\n" },
          "glab config": { stdout: "glpat-test\n" },
          "glab api": listed,
        });
        return Effect.result(autoMergingHere("/w", run)).pipe(Effect.provide(forgeHttpOver(run)));
      };
      const merging = yield* asked({
        stdout:
          '[{"iid":3,"web_url":"https://u/3","merge_when_pipeline_succeeds":true,"state":"opened","created_at":"2026-10-20T12:00:00Z"}]',
      });
      expect(merging).toMatchObject({ _tag: "Success", success: "https://u/3" });
      expect(yield* asked({ stdout: "[]" })).toMatchObject({ _tag: "Success", success: null });
      const unread = yield* asked({ code: 1 });
      expect(unread._tag).toBe("Failure");
      expect(unread._tag === "Failure" ? unread.failure : "").toContain(
        "could not list gitlab.example.com/group/app's merge requests",
      );
    }),
  ));

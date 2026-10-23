import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Schema } from "effect";
import type { MrForge } from "../src/board-model";
import { FORGES } from "../src/forge/forge";
import { rollupChecks } from "../src/forge/github";
import { gitlab, pipelineChecks } from "../src/forge/gitlab";
import type { ReviewRead } from "../src/forge/review";
import { shell } from "../src/mr";
import { FakeBin } from "./support/bin";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeBin,
  forgeOnPath,
  CLI,
  type FakeMr,
  type ForgeModel,
} from "./support/forge";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MERGED = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";

const mr = (forge: MrForge, over: Partial<FakeMr> = {}): FakeMr => ({
  project: PROJECT[forge],
  iid: "30",
  state: "open",
  head: HEAD,
  ...over,
});

const model = (forge: MrForge, over: Partial<ForgeModel> = {}): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST[forge]],
  login: "me",
  mrs: [mr(forge)],
  ...over,
});

const ref = (forge: MrForge) => ({ project: PROJECT[forge], iid: "30" });

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  const host = FORGE_HOST[name];

  describe(`the ${name} forge`, () => {
    test("lists open issues, files one, and comments on it through its own CLI", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              issues: [
                {
                  project: PROJECT[name],
                  number: 1,
                  title: "Open",
                  body: "Evidence",
                  state: "open",
                },
                {
                  project: PROJECT[name],
                  number: 2,
                  title: "Closed",
                  body: "Old",
                  state: "closed",
                },
              ],
            }),
          );
          const first = yield* forge.issues(PROJECT[name], "/w", fake.run);
          expect(first).toMatchObject({
            ok: true,
            issues: [{ number: 1, title: "Open", body: "Evidence" }],
          });
          const filed = yield* forge.fileIssue(PROJECT[name], "Problem", "Details", "/w", fake.run);
          expect(filed).toMatchObject({ ok: true, number: 3 });
          if (!filed.ok) throw new Error(filed.reason);
          expect(filed.url).toBe(
            `https://${PROJECT[name]}/${name === "gitlab" ? "-/issues" : "issues"}/3`,
          );
          expect(
            yield* forge.commentIssue(PROJECT[name], 3, "More evidence", "/w", fake.run),
          ).toEqual({ ok: true, reason: "" });
          expect(fake.model().issueNotes).toEqual({ [`${PROJECT[name]}#3`]: ["More evidence"] });
          expect(yield* forge.issues(PROJECT[name], "/w", fake.run)).toMatchObject({
            ok: true,
            issues: [{ number: 1 }, { number: 3, title: "Problem", body: "Details" }],
          });
        }),
      ));

    test("lists open issues beyond the first page", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              issues: Array.from({ length: 103 }, (_, index) => ({
                project: PROJECT[name],
                number: index + 1,
                title: "Open",
                body: "Evidence",
                state: "open",
              })),
            }),
          );
          const listed = yield* forge.issues(PROJECT[name], "/w", fake.run);
          expect(listed.ok).toBe(true);
          if (!listed.ok) throw new Error(listed.reason);
          expect(listed.issues).toHaveLength(103);
          expect(listed.issues.at(-1)?.number).toBe(103);
        }),
      ));

    test("refuses issue operations when the CLI fails or returns an unreadable answer", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { installed: false }));
          expect((yield* forge.issues(PROJECT[name], "/w", fake.run)).ok).toBe(false);
          expect(
            (yield* forge.fileIssue(PROJECT[name], "Problem", "Evidence", "/w", fake.run)).ok,
          ).toBe(false);
          expect((yield* forge.commentIssue(PROJECT[name], 1, "Evidence", "/w", fake.run)).ok).toBe(
            false,
          );
          const broken = () => Effect.succeed({ code: 0, stdout: "unreadable" });
          expect((yield* forge.issues(PROJECT[name], "/w", broken)).ok).toBe(false);
          expect(
            (yield* forge.fileIssue(PROJECT[name], "Problem", "Evidence", "/w", broken)).ok,
          ).toBe(false);
        }),
      ));

    test("is ready only with its CLI installed and logged in to the host", () =>
      runEffect(
        Effect.gen(function* () {
          const ask = (over: Partial<ForgeModel>) =>
            forge.ready(PROJECT[name], "/w", fakeForge(name, model(name, over)).run);
          expect(yield* ask({})).toEqual({ ok: true, reason: "" });
          expect(yield* ask({ installed: false })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not installed`,
          });
          expect(yield* ask({ loggedIn: [] })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not logged in to ${host}`,
          });
        }),
      ));

    test("says who its CLI is logged in as, and null where it will not", () =>
      runEffect(
        Effect.gen(function* () {
          expect(yield* forge.login("/w", fakeForge(name, model(name)).run)).toBe("me");
          expect(yield* forge.login("/w", fakeForge(name, model(name, { login: null })).run)).toBe(
            null,
          );
        }),
      ));

    test("reads a merge request open, merged or closed, with its head, merge commit and merge time", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            forge.details(
              ref(name),
              "/w",
              fakeForge(name, model(name, { mrs: [mr(name, over)] })).run,
            );
          const open = yield* read({});
          expect(open).toMatchObject({
            _tag: "Details",
            iid: "30",
            project: PROJECT[name],
            state: name === "gitlab" ? "opened" : "open",
            head: HEAD,
            headSha: "1a2b3c4",
            mergedSha: "",
          });
          expect(
            yield* read({ state: "merged", mergedSha: MERGED, mergedAt: "2026-10-15T08:00:00Z" }),
          ).toMatchObject({
            state: "merged",
            mergedSha: MERGED,
            mergedAt: "2026-10-15T08:00:00Z",
          });
          expect(yield* read({ state: "closed" })).toMatchObject({ state: "closed" });
          expect(yield* read({ state: "closed", draft: true })).toMatchObject({ state: "closed" });
          expect(yield* read({ state: "merged", draft: true, mergedSha: MERGED })).toMatchObject({
            state: "merged",
            mergedSha: MERGED,
          });
        }),
      ));

    test("says whether it would merge it now, by its own rules and in its own words", () =>
      runEffect(
        Effect.gen(function* () {
          const mergeable = (over: Partial<FakeMr>) =>
            forge
              .details(ref(name), "/w", fakeForge(name, model(name, { mrs: [mr(name, over)] })).run)
              .pipe(Effect.map((panel) => (panel._tag === "Details" ? panel.mergeable : null)));
          expect(yield* mergeable({})).toEqual({ state: "mergeable", said: "mergeable" });
          expect((yield* mergeable({ mergeable: "conflict" }))?.state).toBe("blocked");
          expect((yield* mergeable({ mergeable: "unapproved" }))?.state).toBe("blocked");
          expect((yield* mergeable({ mergeable: "checking" }))?.state).toBe("unknown");
          expect((yield* mergeable({ mergeable: "conflict" }))?.said).toBe(
            name === "gitlab" ? "conflict" : "conflicting",
          );
          expect((yield* mergeable({ mergeable: "unapproved" }))?.said).toBe(
            name === "gitlab" ? "not approved" : "blocked",
          );
        }),
      ));

    test("reads the whole panel: draft, people, branches, approval, auto-merge and when it moved", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            forge.details(
              ref(name),
              "/w",
              fakeForge(name, model(name, { mrs: [mr(name, over)] })).run,
            );
          expect(
            yield* read({
              title: "Cards",
              author: "ann",
              assignees: ["me"],
              sourceBranch: "me/cards",
              targetBranch: "main",
              approved: true,
              autoMerge: true,
              updatedAt: "2026-10-01T12:00:00Z",
            }),
          ).toMatchObject({
            title: "Cards",
            author: "ann",
            assignees: ["me"],
            sourceBranch: "me/cards",
            targetBranch: "main",
            approvals: "approved",
            autoMerge: true,
            updatedAt: epochMs("2026-10-01T12:00:00Z"),
          });
          expect(yield* read({ draft: true })).toMatchObject({ state: "draft", autoMerge: false });
        }),
      ));

    test("says whether the reviewed branch comes from a fork", () =>
      runEffect(
        Effect.gen(function* () {
          for (const fork of [false, true])
            expect(
              yield* forge.details(
                ref(name),
                "/w",
                fakeForge(name, model(name, { mrs: [mr(name, { fork })] })).run,
              ),
            ).toMatchObject({ fork });
        }),
      ));

    test("reads its checks passed, failed or running", () =>
      runEffect(
        Effect.gen(function* () {
          const checksOf = (checks: FakeMr["checks"]) =>
            Effect.map(
              forge.details(
                ref(name),
                "/w",
                fakeForge(name, model(name, { mrs: [mr(name, { checks })] })).run,
              ),
              (panel) => (panel._tag === "Details" ? panel.checks : undefined),
            );
          expect(yield* checksOf([{ name: "test", state: "passed" }])).toEqual({ state: "passed" });
          expect(
            yield* checksOf([
              { name: "test", state: "passed" },
              { name: "lint", state: "failed" },
            ]),
          ).toEqual({ state: "failed", name: name === "gitlab" ? "pipeline" : "lint" });
          expect(yield* checksOf([{ name: "e2e", state: "running" }])).toEqual({
            state: "running",
          });
          expect(yield* checksOf([])).toEqual({ state: "none" });
        }),
      ));

    test("keeps the check address its forge supplied", () =>
      runEffect(
        Effect.gen(function* () {
          const url = `https://${host}/checks/42`;
          const panel = yield* forge.details(
            ref(name),
            "/w",
            fakeForge(
              name,
              model(name, {
                mrs: [mr(name, { checks: [{ name: "test", state: "failed" }], checksUrl: url })],
              }),
            ).run,
          );
          expect(panel).toMatchObject({ _tag: "Details", checks: { state: "failed", url } });
        }),
      ));

    test("says why a merge request it cannot read is unavailable", () =>
      runEffect(
        Effect.gen(function* () {
          const gone = yield* forge.details(
            { project: PROJECT[name], iid: "99" },
            "/w",
            fakeForge(name, model(name)).run,
          );
          expect(gone._tag).toBe("Unavailable");
        }),
      ));

    test("posts one note, and approves only where asked, saying what landed", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          const noted = yield* forge.post(ref(name), "LGTM", false, "/w", fake.run);
          expect(noted.ok).toBe(true);
          expect(noted.message).not.toContain("approved");
          expect(fake.model().approved ?? []).toEqual([]);
          const approved = yield* forge.post(ref(name), "Clean", true, "/w", fake.run);
          expect(approved.message).toContain("and approved it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["LGTM", "Clean"]]);
          expect(fake.model().approved?.length).toBe(1);
          const missed = yield* forge.post(
            { project: PROJECT[name], iid: "99" },
            "LGTM",
            false,
            "/w",
            fake.run,
          );
          expect(missed.ok).toBe(false);
        }),
      ));

    test("reports an approval the forge refuses, with the note still posted", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { refusesApproval: true }));
          const posted = yield* forge.post(ref(name), "Clean", true, "/w", fake.run);
          expect(posted.ok).toBe(true);
          expect(posted.message).toContain("and did not approve it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["Clean"]]);
        }),
      ));

    test("lists my open merge requests, as assignee or author, once each", () =>
      runEffect(
        Effect.gen(function* () {
          const mrs = [
            mr(name, { iid: "31", assignees: ["me"], title: "Mine" }),
            mr(name, { iid: "32", author: "me", assignees: ["me"], title: "Both" }),
            mr(name, { iid: "33", author: "ann" }),
            mr(name, { iid: "34", author: "me", state: "merged" }),
          ];
          expect(
            yield* forge.mine(PROJECT[name], "/w", fakeForge(name, model(name, { mrs })).run),
          ).toEqual([
            { iid: "31", title: "Mine" },
            { iid: "32", title: "Both" },
          ]);
        }),
      ));

    test("opens one in a browser", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          expect((yield* forge.open(ref(name), "/w", fake.run)).code).toBe(0);
          expect(fake.calls.at(-1)).toContain("--web");
        }),
      ));

    test("writes the commands a reviewer reads and checks one out with, for its own CLI", () => {
      const said = forge.review(ref(name));
      for (const line of [said.diff, said.view, said.checkout]) {
        expect(line.startsWith(`${CLI[name]} `)).toBe(true);
        expect(line).toContain("30");
      }
    });

    test("keeps shell characters in delivery arguments literal", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "forge-delivery-" });
          const bin = yield* FakeBin.make(`${cwd}/bin`);
          try {
            yield* bin.add(CLI[name], `printf '%s\\n' "$@"`);
            yield* fs.writeFileString(`${cwd}/body.txt`, "description");
            const branch = `feature/${SHELL_WORD}`;
            const assignee = `account${SHELL_WORD}`;
            const existing = `https://${PROJECT[name]}/30?query=${SHELL_WORD}`;
            const commands = forge.commands({ project: PROJECT[name], branch, assignee, existing });
            const lines = commands.create.split("\n");
            const created = yield* shell(
              "sh",
              [
                "-c",
                lines[0]!
                  .replaceAll("<title>", "Change")
                  .replace("<file>", "body.txt")
                  .replace("<iid>", "7"),
              ],
              cwd,
            );
            expect(created.code).toBe(0);
            const args = created.stdout.trimEnd().split("\n");
            expect(args[args.indexOf("--assignee") + 1]).toBe(assignee);
            if (name === "github") {
              expect(lines).toHaveLength(1);
              expect(args[args.indexOf("--head") + 1]).toBe(branch);
              expect(args[args.indexOf("--body-file") + 1]).toBe("body.txt");
            } else {
              const described = yield* shell(
                "sh",
                ["-c", lines[1]!.replace("<file>", "body.txt").replace("<iid>", "7")],
                cwd,
              );
              expect(described.stdout.trimEnd().split("\n")).toEqual([
                "api",
                "--hostname",
                "gitlab.example.com",
                "--method",
                "PUT",
                "projects/group%2Fapp/merge_requests/7",
                "-F",
                "description=@body.txt",
              ]);
            }
            const noted = yield* shell(
              "sh",
              ["-c", commands.comment.replace("<file>", "body.txt")],
              cwd,
            );
            expect(noted.code).toBe(0);
            const said = noted.stdout.trimEnd().split("\n");
            if (name === "github") expect(said[2]).toBe(existing);
            else
              expect(said.slice(-3)).toEqual([
                `projects/group%2Fapp/merge_requests/${existing}/notes`,
                "-F",
                "body=@body.txt",
              ]);
          } finally {
            yield* bin.restore();
          }
        }),
      ));

    test("writes its delivery commands without command substitution", () => {
      const commands = forge.commands({
        project: PROJECT[name],
        branch: "feature/one",
        assignee: "tester",
        existing: "31",
      });
      for (const line of [commands.create, commands.comment]) {
        expect(line).not.toContain("$(");
        expect(line).not.toContain("`");
        expect(line.startsWith(`${CLI[name]} `)).toBe(true);
      }
    });

    test("keeps shell characters in a review target literal", () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "forge-review-" });
          const bin = yield* FakeBin.make(`${cwd}/bin`);
          try {
            yield* bin.add(CLI[name], `printf '%s\\n' "$@"`);
            const commands = forge.review({
              project: `${PROJECT[name]}${SHELL_WORD}`,
              iid: "30",
            });
            for (const line of [commands.diff, commands.view, commands.checkout]) {
              const result = yield* shell("sh", ["-c", line], cwd);
              expect(result.code).toBe(0);
              const args = result.stdout.trimEnd().split("\n");
              expect(args[args.indexOf("--repo") + 1]).toBe(
                name === "github"
                  ? `owner/repo${SHELL_WORD}`
                  : `gitlab.example.com/group/app${SHELL_WORD}`,
              );
            }
          } finally {
            yield* bin.restore();
          }
        }),
      ));
  });
}

// Shell metacharacters without the injection shapes endpoint security flags (SEC-148).
const SHELL_WORD = `'x;y $HOME *`;

const URLS = {
  gitlab: {
    run: "https://gitlab.example.com/group/app/-/pipelines/7",
    other: "https://github.com/owner/repo/actions/runs/7",
  },
  github: {
    run: "https://github.com/owner/repo/actions/runs/7",
    other: "https://gitlab.example.com/group/app/-/pipelines/7",
  },
} as const;

/** A job of pipeline or Actions run 7, as each forge links it. */
const JOB_URL = {
  gitlab: (id: number) => `https://gitlab.example.com/group/app/-/jobs/${id}`,
  github: (id: number) => `https://github.com/owner/repo/actions/runs/7/job/${id}`,
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  describe(`the ${name} forge's deploys`, () => {
    const tierOf = (over: Partial<ForgeModel>) =>
      forge.liveTier(ref(name), MERGED, "/w", fakeForge(name, model(name, over)).run);
    const environments = (stage: string, prod: string, failed = "") => [
      { name: "stage", tier: "staging", deployed: stage },
      { name: "production", tier: "production", deployed: prod, failed },
    ];
    const ancestry = { child: [MERGED] };

    test("say production, then stage, then nothing, and nothing where the forge does not answer", () =>
      runEffect(
        Effect.gen(function* () {
          expect(yield* tierOf({ environments: environments("child", MERGED), ancestry })).toBe(
            "production",
          );
          expect(yield* tierOf({ environments: environments("child", "0ld"), ancestry })).toBe(
            "staging",
          );
          expect(yield* tierOf({ environments: environments("0ld", "0ld"), ancestry })).toBe(null);
          expect(yield* tierOf({ environments: [] })).toBe(null);
          expect(
            yield* tierOf({ environments: environments(MERGED, MERGED), deploysDown: true }),
          ).toBe(null);
        }),
      ));

    test("go by what is live, not by a newer deployment that failed", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* tierOf({ environments: environments("0ld", "0ld", MERGED), ancestry }),
          ).toBe(null);
        }),
      ));

    test("name the commit a tier's newest successful deployment has, none, and why not where the forge does not answer", () =>
      runEffect(
        Effect.gen(function* () {
          const deployed = (tier: "staging" | "production", over: Partial<ForgeModel>) =>
            forge.deployed(ref(name), tier, "/w", fakeForge(name, model(name, over)).run);
          const both = { environments: environments("child", "0ld", MERGED) };
          expect(yield* deployed("staging", both)).toEqual({ ok: true, sha: "child" });
          expect(yield* deployed("production", both)).toEqual({ ok: true, sha: "0ld" });
          expect(yield* deployed("staging", { environments: [] })).toEqual({ ok: true, sha: null });
          expect((yield* deployed("staging", { ...both, deploysDown: true })).ok).toBe(false);
        }),
      ));
  });

  describe(`the ${name} forge's stage per environment`, () => {
    const stages = (environments: ForgeModel["environments"], over: Partial<ForgeModel> = {}) =>
      fakeForge(name, model(name, { environments, ...over })).run;
    const read = (
      commit: string | null,
      environments: ForgeModel["environments"],
      over: Partial<ForgeModel> = {},
    ) => forge.stagingEnvironments(ref(name), commit, "/w", stages(environments, over));
    const success = (sha: string) => ({ sha, status: "success" as const });
    const failed = (sha: string) => ({ sha, status: "failed" as const });

    test("attribution: only selected jobs' deployments count, including a selected job's earlier attempt", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              mrs: [
                mr(name, {
                  jobs: [
                    { name: "stage:playground", state: "passed", id: 23 },
                    { name: "stage:playground", state: "failed", id: 17 },
                    { name: "stage:spilnu", state: "passed", id: 9 },
                  ],
                }),
              ],
              environments: [
                {
                  name: "stage-playground",
                  tier: "staging",
                  deployments: [
                    { sha: HEAD, status: "success", job: "stage:playground", jobId: 17 },
                  ],
                },
                {
                  name: "stage-spilnu",
                  tier: "staging",
                  deployments: [{ sha: HEAD, status: "success", job: "stage:spilnu", jobId: 9 }],
                },
                {
                  name: "stage-manual",
                  tier: "staging",
                  deployments: [{ sha: HEAD, status: "success", logUrl: "" }],
                },
                {
                  name: "stage-bot",
                  tier: "staging",
                  deployments: [
                    { sha: HEAD, status: "success", logUrl: "https://bot.example/log/17" },
                  ],
                },
              ],
            }),
          );
          const read = yield* forge.stagingEnvironments(ref(name), HEAD, "/w", fake.run, [
            "stage:playground",
          ]);
          expect(read).toEqual({
            ok: true,
            environments: [
              { name: "stage-playground", live: HEAD, hasCommit: true },
              { name: "stage-spilnu", live: HEAD, hasCommit: false },
              { name: "stage-manual", live: HEAD, hasCommit: false },
              { name: "stage-bot", live: HEAD, hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: each stage environment's newest successful deployment is read, even where another's is newer", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* read(null, [
              { name: "stage-spilnu", tier: "staging", deployments: [success("newer")] },
              { name: "production", tier: "production", deployments: [success("prod")] },
              { name: "stage-happytiger", tier: "staging", deployments: [success("older")] },
              { name: "review-7", tier: "development", deployments: [success("preview")] },
            ]),
          ).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "newer", hasCommit: false },
              { name: "stage-happytiger", live: "older", hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: a newer failed deployment is not what is live, and none at all is null", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* read(null, [
              {
                name: "stage-spilnu",
                tier: "staging",
                deployments: [failed("broken"), success("good")],
              },
              { name: "stage-happytiger", tier: "staging", deployments: [failed("broken")] },
            ]),
          ).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "good", hasCommit: false },
              { name: "stage-happytiger", live: null, hasCommit: false },
            ],
          });
        }),
      ));

    test("per environment: the environments with a deployment of a commit, whatever its status, are listed", () =>
      runEffect(
        Effect.gen(function* () {
          const read1 = yield* read(HEAD, [
            {
              name: "stage-spilnu",
              tier: "staging",
              deployments: [success("other"), failed(HEAD), success("older")],
            },
            { name: "stage-happytiger", tier: "staging", deployments: [success("older")] },
            { name: "stage-web", tier: "staging", deployments: [success(HEAD)] },
          ]);
          expect(read1).toEqual({
            ok: true,
            environments: [
              { name: "stage-spilnu", live: "other", hasCommit: true },
              { name: "stage-happytiger", live: "older", hasCommit: false },
              { name: "stage-web", live: HEAD, hasCommit: true },
            ],
          });
        }),
      ));

    test("per environment: a read the forge does not answer is a refusal naming the project, not none", () =>
      runEffect(
        Effect.gen(function* () {
          const refused = yield* read(
            HEAD,
            [{ name: "stage-spilnu", tier: "staging", deployments: [success(HEAD)] }],
            { deploysDown: true },
          );
          expect(refused.ok).toBe(false);
          expect(refused.ok ? "" : refused.reason).toContain(PROJECT[name]);
        }),
      ));
  });

  test(`the ${name} forge says how its own pipeline or Actions run went, and nothing of the other's`, () =>
    runEffect(
      Effect.gen(function* () {
        const status = (url: string, runs: ForgeModel["runs"]) =>
          forge.runStatus(url, "/w", fakeForge(name, model(name, { runs })).run);
        expect(
          yield* status(URLS[name].run, { "7": { status: "completed", conclusion: "success" } }),
        ).toBe(name === "gitlab" ? "completed" : "success");
        expect(yield* status(URLS[name].run, { "7": { status: "running" } })).toBe("running");
        expect(yield* status(URLS[name].other, { "7": { status: "running" } })).toBe(null);
        expect(yield* status(URLS[name].run, {})).toBe(null);
      }),
    ));

  test(`the ${name} forge reads its own pipeline's jobs by name with their pages, a job waiting to be started by hand among them`, () =>
    runEffect(
      Effect.gen(function* () {
        const read = (url: string, runs: ForgeModel["runs"]) =>
          forge.pipeline(url, "/w", fakeForge(name, model(name, { runs })).run);
        const done = { status: "completed", conclusion: "success" };
        expect(
          yield* read(URLS[name].run, {
            "7": {
              ...(name === "gitlab" ? { status: "success" } : done),
              ref: "v1.2.0",
              sha: MERGED,
              jobs: [
                { name: "build", state: "passed" },
                { name: "publish", state: "manual" },
              ],
            },
          }),
        ).toEqual({
          ok: true,
          succeeded: true,
          project: PROJECT[name],
          ref: "v1.2.0",
          sha: MERGED,
          jobs: [
            { name: "build", state: "passed", url: JOB_URL[name](1) },
            { name: "publish", state: "manual", url: JOB_URL[name](2) },
          ],
        });
        const running = yield* read(URLS[name].run, {
          "7": {
            status: name === "gitlab" ? "running" : "in_progress",
            ref: "main",
            sha: "0ld",
            jobs: [],
          },
        });
        expect(running).toEqual({
          ok: true,
          succeeded: false,
          project: PROJECT[name],
          ref: "main",
          sha: "0ld",
          jobs: [],
        });
        expect((yield* read(URLS[name].other, { "7": done })).ok).toBe(false);
        expect((yield* read(URLS[name].run, {})).ok).toBe(false);
      }),
    ));
}

test("GitHub finds production beyond a full page of newer deployments", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "github",
        model("github", {
          environments: [
            ...Array.from({ length: 100 }, (_, at) => ({
              name: `preview-${at}`,
              tier: "development",
              deployed: "preview",
            })),
            { name: "production", tier: "production", deployed: MERGED },
          ],
        }),
      );
      expect(yield* FORGES.github.liveTier(ref("github"), MERGED, "/w", fake.run)).toBe(
        "production",
      );
    }),
  ));

for (const name of ["gitlab", "github"] as const)
  test(`the ${name} forge finds the newest pipeline a tag started in the project, and none where it started none`, () =>
    runEffect(
      Effect.gen(function* () {
        const runs: ForgeModel["runs"] = {
          "7": { status: "success", ref: "v1.2.0", sha: MERGED },
          "8": { status: "success", ref: "main", sha: MERGED },
          "9": { status: "failed", ref: "v1.2.0", sha: MERGED },
        };
        const fake = fakeForge(name, model(name, { runs }));
        const found = (tag: string) => FORGES[name].tagPipeline(ref(name), tag, "/w", fake.run);
        expect(yield* found("v1.2.0")).toEqual({
          ok: true,
          url: URLS[name].run.replace(/7$/, "9"),
        });
        expect(yield* found("v9.9.9")).toEqual({ ok: true, url: null });
        expect(
          (yield* FORGES[name].tagPipeline(
            ref(name),
            "v1.2.0",
            "/w",
            fakeForge(name, model(name, { runs, installed: false })).run,
          )).ok,
        ).toBe(false);
      }),
    ));

test("GitHub finds a tag's newest run whatever event started it, a release's among them", () =>
  runEffect(
    Effect.gen(function* () {
      const runs: ForgeModel["runs"] = {
        "7": { status: "success", ref: "v1.2.0", sha: MERGED },
        "9": { status: "failed", ref: "v1.2.0", sha: MERGED, event: "release" },
      };
      const fake = fakeForge("github", model("github", { runs }));
      expect(yield* FORGES.github.tagPipeline(ref("github"), "v1.2.0", "/w", fake.run)).toEqual({
        ok: true,
        url: URLS.github.run.replace(/7$/, "9"),
      });
    }),
  ));

test("attribution: GitLab retains its earlier merged-results deployment without attributing descendants or another MR's merge", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          mrs: [mr("gitlab", { head: "new-head" })],
          ancestry: { [MERGED]: ["target", HEAD], "next-commit": [HEAD] },
          environments: [
            {
              name: "stage-spilnu",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "refs/merge-requests/30/merge", sha: MERGED },
                },
              ],
            },
            {
              name: "stage-teammate",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: "next-commit",
                  status: "success",
                  pipeline: { ref: "feature", sha: "next-commit" },
                },
              ],
            },
            {
              name: "stage-branch-merge",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "feature", sha: MERGED },
                },
              ],
            },
            {
              name: "stage-other-mr",
              tier: "staging",
              job: "deploy-stage",
              deployments: [
                {
                  sha: MERGED,
                  status: "success",
                  pipeline: { ref: "refs/merge-requests/31/merge", sha: MERGED },
                },
              ],
            },
          ],
        }),
      );
      expect(
        yield* FORGES.gitlab.stagingEnvironments(ref("gitlab"), HEAD, "/w", fake.run, [
          "deploy-stage",
        ]),
      ).toEqual({
        ok: true,
        environments: [
          { name: "stage-spilnu", live: MERGED, hasCommit: true },
          { name: "stage-teammate", live: "next-commit", hasCommit: false },
          { name: "stage-branch-merge", live: MERGED, hasCommit: false },
          { name: "stage-other-mr", live: MERGED, hasCommit: false },
        ],
      });
    }),
  ));

test("GitLab reads a stage environment per environment beyond a page of its deployments", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          environments: [
            {
              name: "stage-spilnu",
              tier: "staging",
              deployments: [
                ...Array.from({ length: 120 }, () => ({
                  sha: "failing",
                  status: "failed" as const,
                })),
                { sha: HEAD, status: "success" as const },
              ],
            },
          ],
        }),
      );
      expect(yield* FORGES.gitlab.stagingEnvironments(ref("gitlab"), HEAD, "/w", fake.run)).toEqual(
        { ok: true, environments: [{ name: "stage-spilnu", live: HEAD, hasCommit: true }] },
      );
    }),
  ));

test("GitLab finds a tier's deployment beyond a page of environments and of deployments", () =>
  runEffect(
    Effect.gen(function* () {
      const fake = fakeForge(
        "gitlab",
        model("gitlab", {
          environments: [
            ...Array.from({ length: 120 }, (_, at) => ({
              name: `preview-${at}`,
              tier: "development",
              deployed: "preview",
            })),
            { name: "stage", tier: "staging", deployed: "child" },
          ],
        }),
      );
      expect(yield* FORGES.gitlab.deployed(ref("gitlab"), "staging", "/w", fake.run)).toEqual({
        ok: true,
        sha: "child",
      });
    }),
  ));

test("GitHub reads every page of an Actions run's jobs", () =>
  runEffect(
    Effect.gen(function* () {
      const jobs = [
        ...Array.from({ length: 120 }, (_, at) => ({
          name: `test-${at}`,
          state: "passed" as const,
        })),
        { name: "lint", state: "failed" as const },
      ];
      const fake = fakeForge(
        "github",
        model("github", { runs: { "7": { status: "completed", conclusion: "failure", jobs } } }),
      );
      const read = yield* FORGES.github.pipeline(URLS.github.run, "/w", fake.run);
      expect(read.ok && read.jobs.map((job) => job.state)).toEqual(jobs.map((job) => job.state));
    }),
  ));

test("a status context's state counts as a check run's conclusion does", () => {
  expect(rollupChecks([{ context: "ci/build", state: "PENDING" }])).toEqual({ state: "running" });
  expect(rollupChecks([{ context: "ci/build", state: "SUCCESS" }])).toEqual({ state: "passed" });
  expect(rollupChecks([{ context: "ci/build", state: "ERROR" }])).toEqual({
    state: "failed",
    name: "ci/build",
  });
});

test("each fake answers the same on PATH, logs what it got, and keeps what was posted", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        for (const name of ["gitlab", "github"] as const) {
          const onPath = yield* forgeOnPath(bin, name, model(name));
          expect(yield* FORGES[name].details(ref(name), "/", shell)).toMatchObject({
            _tag: "Details",
            head: HEAD,
          });
          expect((yield* FORGES[name].post(ref(name), "LGTM", false, "/", shell)).ok).toBe(true);
          expect(Object.values((yield* onPath.model()).notes ?? {})).toEqual([["LGTM"]]);
          expect((yield* onPath.calls()).length).toBeGreaterThan(0);
          yield* forgeOnPath(bin, name, model(name, { installed: false }));
          expect(yield* exec([CLI[name], "--version"])).toMatchObject({
            exitCode: 127,
            stdout: "",
          });
        }
      } finally {
        yield* bin.restore();
      }
    }),
  ));

test("the suite's compiled forge fake receives its model and arguments literally", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        const binary = `${bin.dir}/compiled forge's reply`;
        yield* fs.writeFileString(binary, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
        yield* forgeOnPath(bin, "github", model("github")).pipe(
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ COLLIE_TEST_FAKE_FORGE: binary }),
              { asPrimary: true },
            ),
          ),
        );
        const args = ["--version", "words with spaces", "a'b", "line one\nline two", "$literal"];
        expect(yield* exec([CLI.github, ...args])).toEqual({
          exitCode: 0,
          stdout: ["github", `${bin.dir}/github.model.json`, ...args].join("\n") + "\n",
          stderr: "",
        });
      } finally {
        yield* bin.restore();
      }
    }),
  ));

test("a forge call that changes nothing leaves the model as a test last wrote it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" })}/gitlab.model.json`;
      const written = `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(model("gitlab"))}\n`;
      yield* fs.writeFileString(file, written);
      yield* forgeBin("gitlab", file, ["api", "--hostname", FORGE_HOST.gitlab, "environments"]);
      expect(yield* fs.readFileString(file)).toBe(written);
    }),
  ));

test("the source forge fake works with no Bun command on PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        const onPath = yield* forgeOnPath(bin, "github", model("github")).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        );
        expect(
          yield* exec([CLI.github, "--version"], {
            env: { ...Bun.env, PATH: `${bin.dir}:/usr/bin:/bin` },
          }),
        ).toEqual({
          exitCode: 0,
          stdout: "gh version 2.0.0",
          stderr: "",
        });
        expect(yield* onPath.calls()).toEqual(["gh --version"]);
      } finally {
        yield* bin.restore();
      }
    }),
  ));

const TEMPLATES = {
  gitlab: [".gitlab/merge_request_templates/default.md"],
  github: [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
  ],
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  test(`the ${name} forge finds a branch's open merge request, none, and auto-merge`, () =>
    runEffect(
      Effect.gen(function* () {
        const open = mr(name, { iid: "31", sourceBranch: "me/x" });
        const ask = (mrs: ReadonlyArray<FakeMr>) =>
          forge.forBranch(PROJECT[name], "me/x", "/w", fakeForge(name, model(name, { mrs })).run);
        expect(yield* ask([mr(name, { sourceBranch: "other" })])).toEqual({ ok: true, open: null });
        expect(yield* ask([open])).toMatchObject({
          ok: true,
          open: { iid: "31", autoMerge: false },
        });
        expect(yield* ask([{ ...open, autoMerge: true }])).toMatchObject({
          open: { autoMerge: true },
        });
        expect(
          yield* ask([
            { ...open, targetBranch: "main" },
            { ...open, iid: "32", targetBranch: "release", autoMerge: true },
          ]),
        ).toMatchObject({
          open: {
            iid: "32",
            autoMerge: true,
            url:
              name === "github"
                ? "https://github.com/owner/repo/pull/32"
                : "https://gitlab.example.com/group/app/-/merge_requests/32",
          },
        });
        expect(
          (yield* forge.forBranch(
            PROJECT[name],
            "me/x",
            "/w",
            fakeForge(name, model(name, { installed: false })).run,
          )).ok,
        ).toBe(false);
      }),
    ));

  test(`the ${name} forge says a branch is protected by the default branch or any rule, and null where it cannot read`, () =>
    runEffect(
      Effect.gen(function* () {
        const ask = (branch: string, over: Partial<ForgeModel> = {}) =>
          forge.protects(
            PROJECT[name],
            branch,
            "/w",
            fakeForge(name, model(name, { defaultBranch: "main", ...over })).run,
          );
        const rule =
          name === "gitlab"
            ? { protectedBranches: [{ name: "release/*" }] }
            : { rulesets: ["release/*"] };
        expect(yield* ask("main")).toBe(true);
        expect(yield* ask("me/not-pushed-yet")).toBe(false);
        expect(yield* ask("release/2.0", rule)).toBe(true);
        expect(yield* ask("me/not-pushed-yet", rule)).toBe(false);
        expect(
          yield* ask("release/2.0", {
            protectedBranches: [{ name: "release/*", allowForcePush: true }],
          }),
        ).toBe(true);
        expect(yield* ask("me/x", { protectionDown: true })).toBeNull();
        expect(yield* ask("me/x", { installed: false })).toBeNull();
      }),
    ));

  test(`the ${name} forge lists a branch's merge requests in every state, and says when it cannot`, () =>
    runEffect(
      Effect.gen(function* () {
        const from = (over: Partial<FakeMr>) =>
          mr(name, { sourceBranch: "me/x", createdAt: "2026-10-15T08:00:00Z", ...over });
        const mrs = [
          from({ iid: "31" }),
          from({ iid: "32", state: "merged", mergedAt: "2026-10-15T08:40:00Z" }),
          from({ iid: "33", state: "closed", closedAt: "2026-10-15T09:00:00Z" }),
          mr(name, { iid: "34", sourceBranch: "other" }),
        ];
        const listed = yield* forge.fromBranch(
          PROJECT[name],
          "me/x",
          "/w",
          fakeForge(name, model(name, { mrs })).run,
        );
        const url = (iid: string) =>
          name === "github"
            ? `https://github.com/owner/repo/pull/${iid}`
            : `https://gitlab.example.com/group/app/-/merge_requests/${iid}`;
        expect(listed).toEqual({
          ok: true,
          mrs: [
            {
              iid: "31",
              url: url("31"),
              state: "open",
              created: "2026-10-15T08:00:00Z",
              ended: null,
            },
            {
              iid: "32",
              url: url("32"),
              state: "merged",
              created: "2026-10-15T08:00:00Z",
              ended: "2026-10-15T08:40:00Z",
            },
            {
              iid: "33",
              url: url("33"),
              state: "closed",
              created: "2026-10-15T08:00:00Z",
              ended: "2026-10-15T09:00:00Z",
            },
          ],
        });
        for (const over of [{ installed: false }, { loggedIn: [] }])
          expect(
            (yield* forge.fromBranch(
              PROJECT[name],
              "me/x",
              "/w",
              fakeForge(name, model(name, { mrs, ...over })).run,
            )).ok,
          ).toBe(false);
      }),
    ));

  test(`the ${name} forge reads a check's job on the merge request's head, in every state, and says when it cannot`, () =>
    runEffect(
      Effect.gen(function* () {
        const read = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
          forge.job(
            ref(name),
            "nuxi-typecheck",
            "/w",
            fakeForge(name, model(name, { mrs: [mr(name, over)], ...rest })).run,
          );
        const url =
          name === "github"
            ? "https://github.com/owner/repo/runs/2"
            : "https://gitlab.example.com/group/app/-/jobs/2";
        for (const state of [
          "passed",
          "pending",
          "running",
          "failed",
          "skipped",
          "cancelled",
        ] as const)
          expect(
            yield* read({
              jobs: [
                { name: "lint", state: "failed" },
                { name: "nuxi-typecheck", state },
              ],
            }),
          ).toEqual({ ok: true, head: HEAD, state, url, id: "2", merge: null });
        expect(yield* read({ jobs: [{ name: "lint", state: "passed" }] })).toEqual({
          ok: true,
          head: HEAD,
          state: "missing",
          url: null,
          id: null,
          merge: null,
        });
        for (const rest of [{ installed: false }, { loggedIn: [] }])
          expect((yield* read({ jobs: [] }, rest)).ok).toBe(false);
      }),
    ));

  test(`the ${name} forge reads a job where the branch leaves its target, else on the target's latest, and fails safe`, () =>
    runEffect(
      Effect.gen(function* () {
        const BASE = "b".repeat(40);
        const TIP = "c".repeat(40);
        const failed = [{ name: "nuxi-typecheck", state: "failed" as const }];
        const passed = [{ name: "nuxi-typecheck", state: "passed" as const }];
        const read = (over: Partial<FakeMr>) =>
          forge.baseJob(
            ref(name),
            "nuxi-typecheck",
            "/w",
            fakeForge(name, model(name, { mrs: [mr(name, { targetBranch: "main", ...over })] }))
              .run,
          );
        expect(
          yield* read({ base: { at: BASE, jobs: failed }, target: { at: TIP, jobs: passed } }),
        ).toMatchObject({ ok: true, at: BASE, state: "failed" });
        expect(
          yield* read({ base: { at: BASE }, target: { at: TIP, jobs: failed } }),
        ).toMatchObject({ ok: true, at: TIP, state: "failed" });
        expect((yield* read({ base: { at: BASE } })).ok).toBe(false);
        expect((yield* read({ target: { at: TIP, jobs: failed } })).ok).toBe(false);
        // CI ran there without it: the target's red job says nothing about it.
        expect(
          yield* read({
            base: { at: BASE, jobs: [{ name: "lint", state: "passed" }] },
            target: { at: TIP, jobs: failed },
          }),
        ).toEqual({ ok: true, at: BASE, state: "missing", url: null });
      }),
    ));

  test(`the ${name} forge retries a job once asked, and says how to read its log`, () =>
    runEffect(
      Effect.gen(function* () {
        const fake = fakeForge(
          name,
          model(name, {
            mrs: [
              mr(name, { jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "passed" }] }),
            ],
          }),
        );
        const job = () => forge.job(ref(name), "nuxi-typecheck", "/w", fake.run);
        expect(yield* job()).toMatchObject({ state: "failed", id: "1" });
        expect(yield* forge.retryJob(ref(name), "1", "/w", fake.run)).toEqual({
          ok: true,
          reason: "",
        });
        expect(yield* job()).toMatchObject({ state: "passed", id: "101" });
        expect((yield* forge.retryJob(ref(name), "9", "/w", fake.run)).ok).toBe(false);
        expect(forge.jobLog(ref(name), "1")).toBe(
          name === "gitlab"
            ? "glab ci trace 1 --repo gitlab.example.com/group/app"
            : "gh run view --job 1 --log --repo owner/repo",
        );
      }),
    ));

  test(`the ${name} forge finds the repository's template wherever it keeps one, and none`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const where of TEMPLATES[name]) {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forge-template-" });
          expect(yield* forge.template(dir)).toBe(null);
          const parent = where.split("/").slice(0, -1).join("/");
          if (parent !== "") yield* fs.makeDirectory(`${dir}/${parent}`, { recursive: true });
          yield* fs.writeFileString(`${dir}/${where}`, "## Description\n");
          expect(yield* forge.template(dir)).toBe(where);
        }
      }),
    ));
}

for (const name of ["gitlab", "github"] as const) {
  test(`the ${name} forge clones a repository into a directory, and refuses where it is not logged in`, () =>
    runEffect(
      Effect.gen(function* () {
        const fake = fakeForge(name, model(name));
        expect(yield* FORGES[name].clone(PROJECT[name], "/into", "/w", fake.run)).toEqual({
          ok: true,
          reason: "",
        });
        expect(fake.model().cloned).toEqual([`${PROJECT[name]} /into`]);
        const out = fakeForge(name, model(name, { loggedIn: [] }));
        const refused = yield* FORGES[name].clone(PROJECT[name], "/into", "/w", out.run);
        expect(refused.ok).toBe(false);
        expect(out.model().cloned ?? []).toEqual([]);
      }),
    ));
}

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} clone keeps a credential helper that asks ${CLI[name]} at each use, and no token`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forge-credentials-" });
        const bin = yield* FakeBin.make(`${dir}/bin`);
        try {
          const onPath = yield* forgeOnPath(bin, name, model(name, { token: "first-token" }));
          const clone = `${dir}/clone`;
          yield* exec(["git", "init", "--quiet", clone]);
          // A global helper with a stale answer, which git would otherwise ask first.
          const global = `${dir}/global.gitconfig`;
          yield* fs.writeFileString(
            global,
            `[credential]\n\thelper = "!f() { echo username=stale; echo password=stale-token; }; f"\n`,
          );
          const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: global,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          };
          const host = FORGE_HOST[name];
          const fill = exec(
            ["sh", "-c", `printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`],
            { cwd: clone, env },
          );

          for (const _ of [1, 2])
            expect(yield* FORGES[name].credentials(PROJECT[name], clone, shell)).toEqual({
              ok: true,
              reason: "",
            });
          expect((yield* fill).stdout).toContain("password=first-token\n");
          yield* onPath.set(model(name, { token: "second-token" }));
          expect((yield* fill).stdout).toContain("password=second-token\n");

          const config = yield* fs.readFileString(`${clone}/.git/config`);
          expect(config).not.toContain("-token");
          expect(config.toLowerCase()).not.toContain("extraheader");
          const helpers = (yield* exec(
            ["git", "config", "--local", "--get-all", `credential.https://${host}.helper`],
            { cwd: clone },
          )).stdout
            .split("\n")
            .slice(0, -1);
          expect(helpers).toHaveLength(2);
          expect(helpers[0]).toBe("");
        } finally {
          yield* bin.restore();
        }
      }),
    ));
}

test("a GitLab pipeline of an older head is not this head's CI, and one that was canceled has not passed", () =>
  runEffect(
    Effect.gen(function* () {
      const checksOf = (over: Partial<FakeMr>) =>
        Effect.map(
          gitlab.details(
            ref("gitlab"),
            "/w",
            fakeForge(
              "gitlab",
              model("gitlab", {
                mrs: [mr("gitlab", { checks: [{ name: "test", state: "passed" }], ...over })],
              }),
            ).run,
          ),
          (panel) => (panel._tag === "Details" ? panel.checks : undefined),
        );
      expect(yield* checksOf({ head: "new-head" })).toEqual({ state: "passed" });
      expect(yield* checksOf({ head: "new-head", pipelineAt: "old-head" })).toEqual({
        state: "unknown",
      });
      expect(pipelineChecks("canceled")).toEqual({ state: "unknown" });
      expect(pipelineChecks("")).toEqual({ state: "none" });
    }),
  ));

test("a GitLab job past the first page of its pipeline's jobs is found", () =>
  runEffect(
    Effect.gen(function* () {
      const jobs = [
        ...Array.from({ length: 100 }, (_, n) => ({
          name: `shard-${n}`,
          state: "passed" as const,
        })),
        { name: "nuxi-typecheck", state: "passed" as const },
      ];
      expect(
        yield* gitlab.job(
          ref("gitlab"),
          "nuxi-typecheck",
          "/w",
          fakeForge("gitlab", model("gitlab", { mrs: [mr("gitlab", { jobs })] })).run,
        ),
      ).toMatchObject({ ok: true, state: "passed", id: "101" });
    }),
  ));

test("a GitLab merged-results pipeline counts for the head it was built from, and one that cannot be shown is not missing", () =>
  runEffect(
    Effect.gen(function* () {
      const MERGE = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
      const TARGET = "0000000000000000000000000000000000000001";
      const read = (over: Partial<FakeMr>, ancestry: Record<string, ReadonlyArray<string>>) =>
        gitlab.job(
          ref("gitlab"),
          "nuxi-typecheck",
          "/w",
          fakeForge(
            "gitlab",
            model("gitlab", {
              mrs: [mr("gitlab", { jobs: [{ name: "nuxi-typecheck", state: "passed" }], ...over })],
              ancestry,
            }),
          ).run,
        );
      expect(yield* read({ pipelineAt: MERGE }, { [MERGE]: [TARGET, HEAD] })).toEqual({
        ok: true,
        head: HEAD,
        state: "passed",
        url: "https://gitlab.example.com/group/app/-/jobs/1",
        id: "1",
        merge: MERGE,
      });
      // A pipeline of an older head: this head's has not started.
      expect(
        yield* read({ pipelineAt: MERGE }, { [MERGE]: [TARGET, "an-older-head"] }),
      ).toMatchObject({ ok: true, state: "pending" });
      const unshown = yield* read({ pipelineAt: MERGE }, {});
      expect(unshown.ok).toBe(false);
      if (!unshown.ok) expect(unshown.reason).toContain(MERGE);
    }),
  ));

const WEB = {
  gitlab: "https://gitlab.example.com/group/app/-/merge_requests/30",
  github: "https://github.com/owner/repo/pull/30",
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  /** A thread, by the id of its first comment: GitLab's discussion, GitHub's first review comment. */
  const thread = (first: number) => (name === "gitlab" ? `d${first}` : String(first));
  /** A comment's address: GitLab's note, GitHub's review comment or issue comment. */
  const urlOf = (id: number, threaded: boolean) =>
    name === "gitlab"
      ? `${WEB.gitlab}#note_${id}`
      : `${WEB.github}#${threaded ? "discussion_r" : "issuecomment-"}${id}`;
  const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, "0")}:00Z`;
  const read = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
    forge.readReview(
      ref(name),
      "/w",
      fakeForge(name, model(name, { mrs: [mr(name, over)], ...rest })).run,
    );

  describe(`the ${name} forge's review read`, () => {
    test("reads the state, head, pipeline, mergeability and every comment with its kind and place", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            checks: [{ name: "test", state: "passed" }],
            comments: [
              {
                id: 11,
                author: "alice",
                at: at(0),
                body: "Rename this",
                thread: thread(11),
                file: "src/a.ts",
                line: 4,
              },
              { id: 12, author: "bob", at: at(5), body: "Agreed", thread: thread(11) },
              { id: 13, author: "renovate", kind: "bot", at: at(10), body: "Bumped" },
              { id: 15, author: "me", at: at(20), body: "Pushed a fix" },
            ],
          });
          if (!review.ok) throw new Error(review.reason);
          expect(review).toMatchObject({
            login: "me",
            state: "open",
            head: HEAD,
            merged: null,
            pipeline: { state: "passed" },
            mergeable: { state: "mergeable" },
            approved: true,
            changesRequested: false,
          });
          expect(review.comments).toEqual([
            {
              id: "11",
              url: urlOf(11, true),
              thread: thread(11),
              author: "alice",
              kind: "person",
              at: at(0),
              body: "Rename this",
              file: "src/a.ts",
              line: 4,
              external: true,
              answered: false,
            },
            {
              id: "12",
              url: urlOf(12, true),
              thread: thread(11),
              author: "bob",
              kind: "person",
              at: at(5),
              body: "Agreed",
              file: null,
              line: null,
              external: true,
              answered: false,
            },
            expect.objectContaining({ id: "13", kind: "bot", thread: null, external: false }),
            expect.objectContaining({ id: "15", author: "me", kind: "person", external: false }),
          ]);
        }),
      ));

    test("counts a comment answered by Collie's later reply in its thread, a reply that links it, or a resolved thread", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            comments: [
              { id: 11, author: "alice", at: at(0), body: "One", thread: thread(11) },
              { id: 12, author: "me", at: at(5), body: "Fixed in abc1234", thread: thread(11) },
              { id: 21, author: "carol", at: at(10), body: "Two" },
              { id: 22, author: "me", at: at(15), body: `Fixed: ${urlOf(21, false)}` },
              { id: 31, author: "dave", at: at(20), body: "Three", thread: thread(31) },
              { id: 41, author: "erin", at: at(25), body: "Four" },
              { id: 2, author: "gus", at: at(27), body: "Five" },
              { id: 51, author: "me", at: at(30), body: "Note", thread: thread(51) },
              { id: 52, author: "frank", at: at(35), body: "Six", thread: thread(51) },
            ],
            resolved: [thread(31)],
          });
          if (!review.ok) throw new Error(review.reason);
          const answered = Object.fromEntries(
            review.comments.filter((one) => one.external).map((one) => [one.id, one.answered]),
          );
          expect(answered).toEqual({
            "11": true,
            "21": true,
            "31": true,
            "41": false,
            // Linked by 22 only as part of comment 21's address.
            "2": false,
            "52": false,
          });
        }),
      ));

    test("answers a reply where it belongs, with its body as given, and never resolves the thread", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              now: at(50),
              mrs: [
                mr(name, {
                  comments: [
                    { id: 11, author: "alice", at: at(0), body: "Inline", thread: thread(11) },
                    { id: 21, author: "carol", at: at(10), body: "On the whole" },
                  ],
                }),
              ],
            }),
          );
          const body = "@file stays as written";
          expect(
            yield* forge.reply(ref(name), { thread: thread(11) }, body, "/w", fake.run),
          ).toEqual({
            ok: true,
            reason: "",
          });
          const linked = `Not changed: ${urlOf(21, false)}`;
          expect(yield* forge.reply(ref(name), { thread: null }, linked, "/w", fake.run)).toEqual({
            ok: true,
            reason: "",
          });
          expect(fake.model().replies).toEqual({
            [`${PROJECT[name]}${name === "gitlab" ? "!" : "#"}30`]: [
              { thread: thread(11), body },
              { thread: null, body: linked },
            ],
          });
          expect(fake.model().mrs[0]?.resolved).toBeUndefined();
          const review = yield* forge.readReview(ref(name), "/w", fake.run);
          if (!review.ok) throw new Error(review.reason);
          expect(
            review.comments.filter((one) => one.external).map((one) => [one.id, one.answered]),
          ).toEqual([
            ["11", true],
            ["21", true],
          ]);
          const missing = yield* forge.reply(
            ref(name),
            { thread: thread(99) },
            "x",
            "/w",
            fake.run,
          );
          expect(missing.ok).toBe(false);
        }),
      ));

    test("merges at the head through the REST merge, never `mr merge`, admin or auto-merge", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(
            name,
            model(name, {
              now: at(55),
              mergeMethod: "SQUASH",
              mrs: [mr(name, { mergedSha: MERGED })],
            }),
          );
          expect(yield* forge.merge(ref(name), HEAD, "/w", fake.run)).toEqual({
            _tag: "Merged",
            merged: MERGED,
          });
          expect(fake.model().merges).toEqual([
            {
              key: `${PROJECT[name]}${name === "gitlab" ? "!" : "#"}30`,
              sha: HEAD,
              method: name === "github" ? "squash" : null,
              fields: name === "gitlab" ? [`sha=${HEAD}`] : [`sha=${HEAD}`, "merge_method=squash"],
              by: "me",
              at: at(55),
            },
          ]);
          const said = fake.calls.join("\n");
          expect(said).not.toMatch(/mr merge|pr merge|--admin|auto/);
        }),
      ));

    test("answers a moved head, an unmergeable one and one already merged without merging", () =>
      runEffect(
        Effect.gen(function* () {
          const ask = (over: Partial<FakeMr>, head = HEAD) => {
            const fake = fakeForge(name, model(name, { mrs: [mr(name, over)] }));
            return Effect.map(forge.merge(ref(name), head, "/w", fake.run), (answer) => ({
              answer,
              merges: fake.model().merges,
            }));
          };
          expect(yield* ask({}, "0ld")).toEqual({
            answer: { _tag: "HeadMoved", head: HEAD },
            merges: undefined,
          });
          const conflicted = yield* ask({ mergeable: "conflict" });
          expect(conflicted.answer._tag).toBe("Refused");
          expect(conflicted.merges).toBeUndefined();
          expect(
            (yield* ask({
              state: "merged",
              mergedSha: MERGED,
              mergedBy: "alice",
              mergedAt: at(40),
            })).answer,
          ).toEqual({ _tag: "AlreadyMerged", merged: MERGED, head: HEAD, by: "alice", at: at(40) });
        }),
      ));

    test("reads a merged merge request's commit, who merged it and when", () =>
      runEffect(
        Effect.gen(function* () {
          const review = yield* read({
            state: "merged",
            mergedSha: MERGED,
            mergedBy: "alice",
            mergedAt: at(40),
          });
          expect(review).toMatchObject({
            ok: true,
            state: "merged",
            merged: { sha: MERGED, by: "alice", at: at(40) },
          });
        }),
      ));

    test("says why where the forge cannot be asked", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { installed: false }));
          const review = yield* forge.readReview(ref(name), "/w", fake.run);
          expect(review.ok).toBe(false);
          if (!review.ok) expect(review.reason).toContain(CLI[name]);
          expect((yield* forge.reply(ref(name), { thread: null }, "x", "/w", fake.run)).ok).toBe(
            false,
          );
          expect((yield* forge.merge(ref(name), HEAD, "/w", fake.run))._tag).toBe("Refused");
          const unread = yield* forge.readReview(
            { project: PROJECT[name], iid: "99" },
            "/w",
            fakeForge(name, model(name)).run,
          );
          expect(unread.ok).toBe(false);
        }),
      ));

    test("leaves Collie's own approval out of the approvers", () =>
      runEffect(
        Effect.gen(function* () {
          const review =
            name === "gitlab"
              ? yield* read({ required: 1, approvers: ["me"] })
              : yield* read(
                  { reviews: [{ id: 901, author: "me", state: "APPROVED", at: at(1) }] },
                  { reviewsRequired: { classic: 1 } },
                );
          expect(review).toMatchObject({ ok: true, approved: false, approvers: [] });
          if (review.ok) expect(review.unapproved).toContain("me's own");
        }),
      ));
  });
}

const reviewOn = (name: MrForge, over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
  FORGES[name].readReview(
    ref(name),
    "/w",
    fakeForge(name, model(name, { mrs: [mr(name, { targetBranch: "main", ...over })], ...rest }))
      .run,
  );

const approval = (review: ReviewRead) => {
  if (!review.ok) throw new Error(review.reason);
  return { approved: review.approved, approvers: review.approvers };
};

test("GitLab counts each approval rule again without Collie's approval, on every tier", () =>
  runEffect(
    Effect.gen(function* () {
      const gitlabOn = (over: Partial<FakeMr>, rest: Partial<ForgeModel> = {}) =>
        Effect.map(reviewOn("gitlab", over, rest), approval);
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "me"] })).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "bob", "me"] })).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // Collie's approval is the only one on the second rule.
      const rules = [
        { name: "Maintainers", required: 1, approvers: ["alice"] },
        { name: "Security", required: 1, approvers: ["me"] },
      ];
      expect(yield* gitlabOn({ rules, approvers: ["alice", "me"] })).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      const free = { free: true } as const;
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "me"] }, free)).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(yield* gitlabOn({ required: 2, approvers: ["alice", "bob", "me"] }, free)).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // No rule requires an approval.
      expect(yield* gitlabOn({})).toEqual({ approved: true, approvers: [] });
      const asked = yield* reviewOn("gitlab", { changesRequested: true });
      expect(asked).toMatchObject({ ok: true, approved: false, changesRequested: true });
    }),
  ));

test("GitLab's system notes and access-token bots are not external", () =>
  runEffect(
    Effect.gen(function* () {
      const review = yield* reviewOn("gitlab", {
        comments: [
          {
            id: 1,
            author: "alice",
            kind: "system",
            at: "2026-10-20T10:00:00Z",
            body: "added 1 commit",
          },
          { id: 2, author: "project_7_bot_5f2e", at: "2026-10-20T10:01:00Z", body: "Deployed" },
          { id: 3, author: "dependabot", kind: "bot", at: "2026-10-20T10:02:00Z", body: "Bump" },
        ],
      });
      if (!review.ok) throw new Error(review.reason);
      expect(review.comments.map((one) => [one.kind, one.external])).toEqual([
        ["system", false],
        ["bot", false],
        ["bot", false],
      ]);
    }),
  ));

test("GitHub's approval stands without Collie's only where the base branch's required count is met by others", () =>
  runEffect(
    Effect.gen(function* () {
      const review = (id: number, author: string, state: "APPROVED" | "CHANGES_REQUESTED") => ({
        id,
        author,
        state,
        at: `2026-10-20T10:0${id % 10}:00Z`,
      });
      const githubOn = (
        reviews: ReadonlyArray<ReturnType<typeof review>>,
        rest: Partial<ForgeModel> = {},
      ) => Effect.map(reviewOn("github", { reviews }, rest), approval);
      const two = { reviewsRequired: { classic: 2 } };
      expect(
        yield* githubOn([review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")], two),
      ).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      expect(
        yield* githubOn(
          [
            review(1, "alice", "APPROVED"),
            review(2, "me", "APPROVED"),
            review(3, "bob", "APPROVED"),
          ],
          two,
        ),
      ).toEqual({
        approved: true,
        approvers: ["alice", "bob"],
      });
      // A ruleset requiring more than branch protection decides.
      const ruleset = { reviewsRequired: { classic: 1, rulesets: [2] } };
      expect(
        yield* githubOn([review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")], ruleset),
      ).toEqual({
        approved: false,
        approvers: ["alice"],
      });
      // Approved by others alone needs no count.
      expect(
        yield* githubOn([review(1, "alice", "APPROVED")], { reviewsRequired: { classic: 1 } }),
      ).toEqual({
        approved: true,
        approvers: ["alice"],
      });
      const unread = yield* reviewOn(
        "github",
        { reviews: [review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")] },
        { reviewsRequired: { classic: 1 }, protectionDown: true },
      );
      expect(unread).toMatchObject({ ok: true, approved: false });
      if (unread.ok) expect(unread.unapproved).toContain("me's own approval stands");
      const owners = yield* reviewOn(
        "github",
        { reviews: [review(1, "alice", "APPROVED"), review(2, "me", "APPROVED")] },
        { reviewsRequired: { classic: 1, codeOwners: true } },
      );
      expect(owners).toMatchObject({ ok: true, approved: false });
      if (owners.ok) expect(owners.unapproved).toContain("code owners");
    }),
  ));

test("GitHub with no review required is approved unless an external reviewer asks for changes", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reviewOn("github", {})).toMatchObject({
        ok: true,
        approved: true,
        changesRequested: false,
      });
      const asked = yield* reviewOn("github", {
        reviews: [
          {
            id: 1,
            author: "alice",
            state: "CHANGES_REQUESTED",
            body: "Please split this",
            at: "2026-10-20T10:00:00Z",
          },
        ],
      });
      expect(asked).toMatchObject({ ok: true, approved: false, changesRequested: true });
      // The review's body is a comment of its own.
      if (asked.ok)
        expect(asked.comments).toEqual([
          expect.objectContaining({
            id: "1",
            url: "https://github.com/owner/repo/pull/30#pullrequestreview-1",
            body: "Please split this",
            thread: null,
            external: true,
          }),
        ]);
      const byBot = yield* reviewOn("github", {
        reviews: [
          {
            id: 2,
            author: "linter",
            bot: true,
            state: "CHANGES_REQUESTED",
            at: "2026-10-20T10:00:00Z",
          },
        ],
      });
      expect(byBot).toMatchObject({ ok: true, approved: true, changesRequested: false });
      const withdrawn = yield* reviewOn("github", {
        reviews: [
          { id: 3, author: "alice", state: "CHANGES_REQUESTED", at: "2026-10-20T10:00:00Z" },
          { id: 4, author: "alice", state: "APPROVED", at: "2026-10-20T10:05:00Z" },
        ],
      });
      expect(withdrawn).toMatchObject({ ok: true, approved: true, changesRequested: false });
    }),
  ));

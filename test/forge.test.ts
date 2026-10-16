import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem } from "effect";
import type { MrForge } from "../src/board-model";
import { FORGES } from "../src/forge/forge";
import { rollupChecks } from "../src/forge/github";
import { gitlab, pipelineChecks } from "../src/forge/gitlab";
import { shell } from "../src/mr";
import { FakeBin } from "./support/bin";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
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

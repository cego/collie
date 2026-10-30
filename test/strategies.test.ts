// What an Input is called is the author's business; what Collie does with it is the
// strategy's.
//
// The shipped workflows happen to call their work source `plan` and their diff target
// `target`, and for as long as Collie looked those names up, a workflow that called them
// anything else quietly lost branch inference, its label, its requirements, its fan-out,
// its previous review and its repository. Every case here is the same workflow twice —
// once under the shipped names, once renamed — asserted to behave identically.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { runOnPath } from "./support/forge";
import { Rig, TEST_LOGIN as LOGIN } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { branchFor, checkoutFor, type BranchAsk } from "../src/worktree";
import { linearIssues, shell } from "../src/mr";
import { Herdr } from "../src/herdr";
import { reviewedTargets } from "../src/inputs";
import { runFacts } from "./support/records";
import {
  exclusiveClashes,
  launchInputProblem,
  repositoryOf,
  strategyMeaning,
  strategyNamed,
} from "../src/strategies";

let rig: Rig;
let bin: FakeBin;

const join = (...parts: string[]) => pipe(Arr.join(parts, "/"), Str.replace(/\/+/g, "/"));

/** The shipped names, and the same two strategies under an author's own names. */
const SHIPPED = { plan: "work-source", target: "diff-target" } as const;
const RENAMED = { spec: "work-source", change: "diff-target" } as const;

beforeEach(() =>
  runOnPath(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      bin = yield* FakeBin.make(join(rig.root, "bin"));
    }),
  ),
);

afterEach(() =>
  runOnPath(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const gitLog = () => join(rig.root, "git.log");

const fakeGit = (branch = "add-picker") =>
  bin.add(
    "git",
    `printf '%s\\t%s\\n' "$PWD" "$*" >> "${gitLog()}"\ncase "$*" in\n${Arr.join(
      [
        `  "remote get-url origin"*) printf '%b' "git@gitlab.example.com:acme/app.git" ;;`,
        `  "symbolic-ref --short refs/remotes/origin/HEAD"*) printf '%b' "origin/master" ;;`,
        `  "rev-parse --verify origin/"*) printf '%b' "deadbeef" ;;`,
        `  "rev-parse --verify --quiet refs/remotes/origin/"*) printf '%b' "deadbeef" ;;`,
        `  "rev-parse --abbrev-ref HEAD"*) printf '%b' "${branch}" ;;`,
        `  "check-ref-format"*) printf '%b' "" ;;`,
        `  "worktree list --porcelain"*) printf '%b' "worktree ${rig.projectDir}\\nbranch refs/heads/${branch}\\n" ;;`,
        // Makes the directory it is asked for, so a roaming checkout really lands.
        `  "worktree add"*) for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\\n" > "$a/.git"; break ;; esac; done ;;`,
        `  "fetch"*) printf '%b' "" ;;`,
        `  "checkout"*) printf '%b' "" ;;`,
        "  *) exit 1 ;;",
      ],
      "\n",
    )}\nesac`,
  );

/** One launch, as a front door settles it: values, where they came from, what they are. */
const asks = (
  inputs: Record<string, string>,
  strategies: Record<string, string>,
  extra: Partial<BranchAsk> = {},
): BranchAsk => ({
  cwd: rig.projectDir,
  name: "Add a picker",
  inputs,
  strategies,
  sources: Rec.fromEntries(Arr.map(Rec.keys(inputs), (key) => [key, "explicit"] as const)),
  login: LOGIN,
  ...extra,
});

test("a branch is named from the work source whatever the work source is called", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      const shipped = yield* branchFor(
        asks({ plan: "/tmp/tasks/add-picker", plan_kind: "plan-dir" }, SHIPPED),
      );
      const renamed = yield* branchFor(
        asks({ spec: "/tmp/tasks/add-picker", spec_kind: "plan-dir" }, RENAMED),
      );

      // The plan directory's own name, not the path to it, under the operator's login.
      expect(shipped.branch).toBe(`${LOGIN}/add-picker`);
      expect(renamed).toEqual(shipped);
    }),
  ));

test("a branch is built from the diff target whatever the diff target is called", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      const shipped = yield* branchFor(asks({ target: "branch:master...fix-login" }, SHIPPED));
      const renamed = yield* branchFor(asks({ change: "branch:master...fix-login" }, RENAMED));

      expect(shipped).toMatchObject({ branch: "fix-login", source: "from target" });
      expect(renamed).toEqual(shipped);
    }),
  ));

test("a review is cut from the reviewed branch whatever the two fields are called", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      const shipped = yield* branchFor(
        asks(
          { plan: "/runs/r1", plan_kind: "review", target: "branch:master...fix-login" },
          SHIPPED,
        ),
      );
      const renamed = yield* branchFor(
        asks(
          { spec: "/runs/r1", spec_kind: "review", change: "branch:master...fix-login" },
          RENAMED,
        ),
      );

      expect(shipped).toMatchObject({ branch: "fix-login", source: "from the reviewed branch" });
      expect(renamed).toEqual(shipped);
    }),
  ));

test("the Linear tickets a branch answers come from the work source's own field", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit("feature/ABC-12-picker");
      const shipped = yield* linearIssues(
        {
          cwd: rig.projectDir,
          inputs: { plan: "DEF-9", plan_kind: "linear" },
          strategies: SHIPPED,
        },
        shell,
      );
      const renamed = yield* linearIssues(
        {
          cwd: rig.projectDir,
          inputs: { spec: "DEF-9", spec_kind: "linear" },
          strategies: RENAMED,
        },
        shell,
      );

      expect(shipped).toEqual(["DEF-9", "ABC-12"]);
      expect(renamed).toEqual(shipped);
    }),
  ));

test("a roaming Run is cut from the repository the strategy names, under a neutral name", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      // Not `repository`, which is only what the shipped roaming workflow calls it.
      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        cwd: rig.projectDir,
        stateDir: rig.stateDir,
        workflow: "batch",
        checkout: "roaming",
        name: "batch",
        workspaceId: null,
        login: LOGIN,
        inputs: { upstream: "" },
        strategies: { upstream: "gitlab-repository" },
      });

      expect(checkout.refused).toBeNull();
      // The directory is not named after the workflow that first needed one.
      expect(checkout.cwd).toBe(join(rig.root, ".herdr", "worktrees", "project", "roaming"));
    }),
  ));

test("the previous review of a change is found whatever the reviewing Run called it", () =>
  runOnPath(
    Effect.gen(function* () {
      const earlier = runFacts({
        workflow: "review",
        project: rig.projectDir,
        state: "succeeded",
        settled: { inputs: { change: "mr:acme/app!42" }, strategies: RENAMED },
      });
      const found = yield* reviewedTargets([earlier], rig.projectDir, 5);
      expect(Arr.map(found, (candidate) => candidate.value)).toEqual(["mr:acme/app!42"]);
    }),
  ));

test("repository is what gitlab-repository was, and the old name is still read as it", () => {
  expect(strategyNamed("gitlab-repository")).toBe("repository");
  expect(strategyNamed("diff-target")).toBe("diff-target");
  const url = "https://github.com/acme/app";
  for (const strategy of ["repository", "gitlab-repository"])
    expect(
      repositoryOf({ inputs: { repository: url }, strategies: { repository: strategy } }),
    ).toMatchObject({
      name: "repository",
      value: url,
    });
  // One launch Input either way, and the refusal names the current name.
  expect(launchInputProblem(["repository"], { repository: "gitlab-repository" })).toBeNull();
  expect(launchInputProblem(["text"], {})).toContain("or repository");
  expect(exclusiveClashes({ a: "repository", b: "gitlab-repository" })).toHaveLength(1);
  expect(strategyMeaning("repository")).toContain("GitHub");
});

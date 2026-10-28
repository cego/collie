// A branch checkout whose path is already held: two clones of one remote with the same
// name want the same directory, and neither may be handed or harmed by the other's (#220).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schedule } from "effect";
import { runOnPath } from "./support/forge";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { Rig, FakeHerdr } from "./support/recorder";
import { checkoutFor, checkoutRefusal, type RecordedBy } from "../src/worktree";
import type { PaneInfo } from "../src/herdr";

const BRANCH = "mk/run-x";

let rig: Rig;
let origin: string;
let cloneA: string;
let cloneB: string;
let first: string;

const git = (cwd: string, ...args: string[]) =>
  exec(["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], {
    cwd,
  }).pipe(
    Effect.map((ran) => {
      if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
      return ran.stdout.trim();
    }),
  );

const gitCode = (cwd: string, ...args: string[]) =>
  exec(["git", ...args], { cwd }).pipe(Effect.map((ran) => ran.exitCode));

beforeEach(() =>
  runOnPath(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      origin = `${rig.root}/origin.git`;
      cloneA = `${rig.root}/a/monorepo`;
      cloneB = `${rig.root}/b/monorepo`;
      first = `${rig.root}/.herdr/worktrees/monorepo/${BRANCH}`;
      const seed = `${rig.root}/seed`;
      yield* exec(["git", "init", "--bare", "-q", "-b", "master", origin]);
      yield* exec(["git", "init", "-q", "-b", "master", seed]);
      yield* git(seed, "commit", "-qm", "base", "--allow-empty");
      yield* git(seed, "switch", "-qc", BRANCH);
      yield* git(seed, "commit", "-qm", "the work", "--allow-empty");
      yield* git(seed, "remote", "add", "origin", origin);
      yield* git(seed, "push", "-q", "origin", "master", BRANCH);
      for (const clone of [cloneA, cloneB]) yield* git(rig.root, "clone", "-q", origin, clone);
    }),
  ),
);

afterEach(() => runOnPath(rig.close()));

const ask = (recordedBy: RecordedBy = () => Effect.succeed(null)) =>
  checkoutFor(new FakeHerdr(rig.pluginEnv()), {
    cwd: cloneA,
    stateDir: rig.stateDir,
    name: "run-x",
    workflow: "stage",
    checkout: "branch",
    inputs: {},
    explicit: BRANCH,
    recordedBy,
  });

const cloneBHoldsFirst = () => git(cloneB, "worktree", "add", "-q", first, BRANCH);

const filesUnder = Effect.fn("branchCheckoutTest.filesUnder")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const files: Record<string, string> = {};
  for (const name of (yield* fs.readDirectory(dir, { recursive: true })).sort()) {
    if (name.startsWith(".git/")) continue;
    const at = `${dir}/${name}`;
    if ((yield* fs.stat(at)).type === "File") files[name] = yield* fs.readFileString(at);
  }
  return files;
});

const looksOf = (dir: string) =>
  Effect.gen(function* () {
    return {
      files: yield* filesUnder(dir),
      head: yield* git(dir, "rev-parse", "HEAD"),
      on: yield* git(dir, "branch", "--show-current"),
      list: yield* git(dir, "worktree", "list", "--porcelain"),
    };
  });

const checkoutsOf = (repo: string, branch: string) =>
  git(repo, "worktree", "list", "--porcelain").pipe(
    Effect.map((list) =>
      list
        .split(/\n\n/)
        .filter((block) => block.includes(`branch refs/heads/${branch}`))
        .map((block) => /^worktree (.+)$/m.exec(block)![1]),
    ),
  );

const hasLocal = (repo: string, branch: string) =>
  gitCode(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).pipe(
    Effect.map((code) => code === 0),
  );

test(
  "another clone's checkout at the branch's path is passed over, and left as it was",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* cloneBHoldsFirst();
        const before = yield* looksOf(first);
        const recordedBy: RecordedBy = (at) =>
          Effect.succeed(
            at === first
              ? {
                  run: "run-b",
                  worktree: null,
                  live: Effect.succeed("run-b is running"),
                  release: Effect.succeed("not taken"),
                }
              : null,
          );

        const checkout = yield* ask(recordedBy);

        expect(checkout.refused).toBeNull();
        expect(checkout.cwd).toBe(`${first}-2`);
        expect(yield* git(checkout.cwd, "branch", "--show-current")).toBe(BRANCH);
        expect(yield* git(checkout.cwd, "rev-parse", "HEAD")).toBe(
          yield* git(origin, "rev-parse", BRANCH),
        );
        expect(yield* git(checkout.cwd, "rev-parse", "--abbrev-ref", "@{u}")).toBe(
          `origin/${BRANCH}`,
        );
        expect(yield* looksOf(first)).toEqual(before);
        expect(checkout.note).toContain(
          `${first} is a checkout of ${cloneB}, recorded by Run run-b`,
        );
      }),
    ),
  60_000,
);

test(
  "a plain directory at the branch's path is passed over, and its files are left alone",
  () =>
    runOnPath(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(first, { recursive: true });
        yield* fs.writeFileString(`${first}/notes.txt`, "mine\n");

        const checkout = yield* ask();

        expect(checkout.refused).toBeNull();
        expect(checkout.cwd).toBe(`${first}-2`);
        expect(yield* filesUnder(first)).toEqual({ "notes.txt": "mine\n" });
      }),
    ),
  60_000,
);

test(
  "a symlink to nothing at the branch's path is passed over, and left pointing where it did",
  () =>
    runOnPath(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(first.slice(0, first.lastIndexOf("/")), { recursive: true });
        yield* fs.symlink(`${rig.root}/gone`, first);

        const checkout = yield* ask();

        expect(checkout.refused).toBeNull();
        expect(checkout.cwd).toBe(`${first}-2`);
        expect(yield* fs.readLink(first)).toBe(`${rig.root}/gone`);
      }),
    ),
  60_000,
);

test(
  "this repository's checkout of another branch at the path is passed over, still on its branch",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* git(cloneA, "worktree", "add", "-q", "-b", "other", first, "origin/master");
        const before = yield* looksOf(first);

        const checkout = yield* ask();

        expect(checkout.cwd).toBe(`${first}-2`);
        expect(yield* looksOf(first)).toMatchObject({
          files: before.files,
          head: before.head,
          on: "other",
        });
      }),
    ),
  60_000,
);

test(
  "the checkout this repository already lists on the branch is the one given",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* git(cloneA, "worktree", "add", "-q", first, BRANCH);

        const checkout = yield* ask();

        expect(checkout.cwd).toBe(first);
        expect(yield* checkoutsOf(cloneA, BRANCH)).toEqual([first]);
      }),
    ),
  60_000,
);

test(
  "asking again after another clone's checkout was passed over reuses the same slot",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* cloneBHoldsFirst();

        const once = yield* ask();
        const twice = yield* ask();

        expect([once.cwd, twice.cwd]).toEqual([`${first}-2`, `${first}-2`]);
        expect(yield* checkoutsOf(cloneA, BRANCH)).toEqual([`${first}-2`]);
      }),
    ),
  60_000,
);

test(
  "two attempts at once end with one checkout, which both are given",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* cloneBHoldsFirst();

        const both = yield* Effect.all([ask(), ask()], { concurrency: 2 });

        expect(both.map((one) => one.refused)).toEqual([null, null]);
        expect(both.map((one) => one.cwd)).toEqual([`${first}-2`, `${first}-2`]);
        expect(yield* checkoutsOf(cloneA, BRANCH)).toEqual([`${first}-2`]);
      }),
    ),
  60_000,
);

test(
  "with all three slots held the start is refused, naming each, and nothing is left behind",
  () =>
    runOnPath(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cloneBHoldsFirst();
        yield* fs.makeDirectory(`${first}-2`, { recursive: true });
        yield* fs.writeFileString(`${first}-2/notes.txt`, "mine\n");
        yield* git(cloneA, "worktree", "add", "-q", "-b", "other", `${first}-3`, "origin/master");
        const before = {
          first: yield* looksOf(first),
          second: yield* filesUnder(`${first}-2`),
          third: yield* looksOf(`${first}-3`),
        };

        for (const _ of [1, 2]) {
          const checkout = yield* ask();

          expect(checkout.refused).toBe(
            `no worktree for ${BRANCH}: ${first} is a checkout of ${cloneB}; ` +
              `${first}-2 is a checkout that does not say which repository it belongs to; ` +
              `${first}-3 is a checkout of ${cloneA}; free one of them and retry`,
          );
          expect(yield* hasLocal(cloneA, BRANCH)).toBe(false);
          expect({
            first: yield* looksOf(first),
            second: yield* filesUnder(`${first}-2`),
            third: yield* looksOf(`${first}-3`),
          }).toEqual(before);
        }
      }),
    ),
  60_000,
);

const gitThat = Effect.fn("branchCheckoutTest.gitThat")(function* (
  before: (real: string) => string,
) {
  const real = Bun.which("git")!;
  const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (bin) => bin.restore());
  yield* bin.add("git", `${before(real)}\nexec "${real}" "$@"`);
});

const takesTheSlot = `if [ "$1" = worktree ] && [ "$2" = add ]; then mkdir -p "$3" && echo theirs > "$3/file"; fi`;
const somebodyTakesTheSlot = () => gitThat(() => takesTheSlot);

test(
  "a cut that fails after the look leaves no branch it made",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* somebodyTakesTheSlot();

        const checkout = yield* ask();

        expect(checkout.refused).toContain(`no worktree for ${BRANCH}`);
        expect(yield* hasLocal(cloneA, BRANCH)).toBe(false);
      }),
    ),
  60_000,
);

test(
  "a cut that fails after the look leaves a branch that was already there where it was",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* git(cloneA, "branch", BRANCH, "origin/master");
        const before = yield* git(cloneA, "rev-parse", BRANCH);
        yield* somebodyTakesTheSlot();

        const checkout = yield* ask();

        expect(checkout.refused).toContain(`no worktree for ${BRANCH}`);
        expect(yield* git(cloneA, "rev-parse", BRANCH)).toBe(before);
      }),
    ),
  60_000,
);

test(
  "a branch somebody else makes between the look and the cut is left where they made it",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* gitThat(
          (real) =>
            `case "$1 $4" in "rev-parse "*'^{commit}') "${real}" -C "${cloneA}" branch -q ${BRANCH} origin/${BRANCH} ;; esac`,
        );

        const checkout = yield* ask();

        expect(checkout.refused).toContain(`no worktree for ${BRANCH}`);
        expect(yield* git(cloneA, "rev-parse", BRANCH)).toBe(
          yield* git(cloneA, "rev-parse", `origin/${BRANCH}`),
        );
      }),
    ),
  60_000,
);

test(
  "a cut that fails after its base moved leaves no branch it made",
  () =>
    runOnPath(
      Effect.gen(function* () {
        yield* gitThat(
          (real) => `case "$1 $4" in "rev-parse "*'^{commit}')
  "${real}" "$@"; code=$?
  "${real}" -C "${cloneA}" update-ref refs/remotes/origin/${BRANCH} origin/master
  exit $code ;;
esac
${takesTheSlot}`,
        );

        const checkout = yield* ask();

        expect(checkout.refused).toContain(`no worktree for ${BRANCH}`);
        expect(yield* hasLocal(cloneA, BRANCH)).toBe(false);
      }),
    ),
  60_000,
);

test(
  "a checkout git lists while another attempt is still filling it is given only once filled",
  () =>
    runOnPath(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const seed = `${rig.root}/seed`;
        yield* fs.writeFileString(`${seed}/.gitattributes`, "payload filter=slow\n");
        yield* fs.writeFileString(`${seed}/payload`, "the work\n");
        yield* git(seed, "add", ".");
        yield* git(seed, "commit", "-qm", "payload");
        yield* git(seed, "push", "-q", "origin", BRANCH);
        yield* git(cloneA, "fetch", "-q", "origin");
        // The smudge filter holds the first checkout half-written until `go` is written.
        const smudging = `${rig.root}/smudging`;
        const go = `${rig.root}/go`;
        yield* exec(["mkfifo", go]);
        const filter = `${rig.root}/smudge`;
        yield* fs.writeFileString(
          filter,
          `#!/bin/sh\ntouch "${smudging}"\nread line < "${go}"\ncat\n`,
        );
        yield* fs.chmod(filter, 0o755);
        yield* git(cloneA, "config", "filter.slow.smudge", filter);

        const filling = yield* Effect.forkChild(ask());
        yield* fs.exists(smudging).pipe(
          Effect.flatMap((there) => (there ? Effect.void : Effect.fail("not yet"))),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 1_000 }),
        );
        const waiting = yield* Effect.forkChild(
          ask().pipe(
            Effect.flatMap((checkout) =>
              fs
                .exists(`${checkout.cwd}/payload`)
                .pipe(Effect.map((filled) => ({ cwd: checkout.cwd, filled }))),
            ),
          ),
        );
        yield* Effect.sleep("1 second");
        yield* fs.writeFileString(go, "go\n");

        const filled = yield* Fiber.join(filling);
        expect(yield* Fiber.join(waiting)).toEqual({ cwd: filled.cwd, filled: true });
      }),
    ),
  60_000,
);

const herdrWith = (panes: ReadonlyArray<PaneInfo>) =>
  new (class extends FakeHerdr {
    override paneList() {
      return Effect.succeed([...panes]);
    }
  })(rig.pluginEnv());

/** The starting Run's checkout: clone A's, on a branch of its own name, at `at`. */
const startedAt = (at: string) =>
  Effect.gen(function* () {
    const checkout = `${rig.root}/.herdr/worktrees/monorepo/implement`;
    yield* git(cloneA, "fetch", "-q", "origin");
    yield* git(cloneA, "worktree", "add", "-q", "-b", "mk/implement", checkout, at);
    return checkout;
  });

const askStarted = (checkout: string, panes: ReadonlyArray<PaneInfo> = []) =>
  checkoutFor(herdrWith(panes), {
    cwd: cloneA,
    stateDir: rig.stateDir,
    name: "run-x",
    workflow: "stage",
    checkout: "branch",
    inputs: {},
    explicit: BRANCH,
    starting: { run: "run-implement", cwd: checkout },
  });

const cutsOf = (repo: string) =>
  Effect.all([git(repo, "worktree", "list", "--porcelain"), git(repo, "branch", "--list")]);

const agentIn = (cwd: string, agentStatus: string): PaneInfo => ({
  paneId: "1-1",
  tabId: "1:1",
  label: null,
  agent: "claude",
  agentStatus,
  workspaceId: null,
  cwd,
  foregroundCwd: null,
  tokens: {},
  terminalId: null,
  agentSession: null,
});

test("a Stage started by a Run whose checkout is clean, at the merge request's head and idle works in it, and cuts nothing", () =>
  runOnPath(
    Effect.gen(function* () {
      const started = yield* startedAt(`origin/${BRANCH}`);
      const before = yield* cutsOf(cloneA);

      const checkout = yield* askStarted(started, [agentIn(started, "idle")]);

      expect(checkout.refused).toBeNull();
      expect(checkout.cwd).toBe(started);
      expect(checkout.worktree).toBeNull();
      expect(checkout.note).toContain(`working in ${started}, Run run-implement's checkout`);
      expect(yield* cutsOf(cloneA)).toEqual(before);
    }),
  ));

test.each([
  {
    held: "uncommitted changes",
    at: `origin/${BRANCH}`,
    dirty: true,
    status: "idle",
    why: "it has uncommitted changes",
  },
  {
    held: "another commit",
    at: "origin/master",
    dirty: false,
    status: "idle",
    why: `it is not at ${BRANCH}'s head on origin`,
  },
  {
    held: "a live agent",
    at: `origin/${BRANCH}`,
    dirty: false,
    status: "working",
    why: "agent claude in pane 1-1 is working in it",
  },
])("a Stage started by a Run whose checkout has $held cuts its own", ({ at, dirty, status, why }) =>
  runOnPath(
    Effect.gen(function* () {
      const started = yield* startedAt(at);
      if (dirty) yield* (yield* FileSystem.FileSystem).writeFileString(`${started}/wip`, "half\n");

      const checkout = yield* askStarted(started, [agentIn(started, status)]);

      expect(checkout.refused).toBeNull();
      expect(checkout.cwd).toBe(first);
      expect(yield* git(first, "branch", "--show-current")).toBe(BRANCH);
      expect(checkout.note).toContain(
        `not working in ${started}, Run run-implement's checkout: ${why}`,
      );
    }),
  ),
);

/** The merge request's branch moves on the remote, from a checkout the starting Run's never fetched. */
const advancedElsewhere = () =>
  Effect.gen(function* () {
    yield* git(cloneB, "switch", "-q", BRANCH);
    yield* git(cloneB, "commit", "-qm", "pushed since", "--allow-empty");
    yield* git(cloneB, "push", "-q", "origin", BRANCH);
    yield* git(cloneB, "switch", "-q", "master");
  });

test("a Stage started by a Run whose checkout is at a head the remote has since moved past cuts its own", () =>
  runOnPath(
    Effect.gen(function* () {
      const started = yield* startedAt(`origin/${BRANCH}`);
      yield* advancedElsewhere();

      const checkout = yield* askStarted(started, [agentIn(started, "idle")]);

      expect(checkout.cwd).toBe(first);
      expect(checkout.note).toContain(
        `not working in ${started}, Run run-implement's checkout: it is not at ${BRANCH}'s head on origin`,
      );
    }),
  ));

test("whether a Stage's checkout would be refused asks the remote's head before counting on the starting Run's", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = yield* startedAt(`origin/${BRANCH}`);
      yield* advancedElsewhere();
      for (const held of [first, `${first}-2`, `${first}-3`]) {
        yield* fs.makeDirectory(held, { recursive: true });
        yield* fs.writeFileString(`${held}/kept`, "kept\n");
      }

      const refused = yield* checkoutRefusal(herdrWith([]), {
        cwd: cloneA,
        name: "run-x",
        inputs: {},
        explicit: BRANCH,
        recordedBy: () => Effect.succeed(null),
        starting: { run: "run-implement", cwd: started },
      });

      expect(refused).toContain(`no worktree for ${BRANCH}: `);
      expect(refused).toContain("free one of them and retry");
    }),
  ));

/** Clone A knows the branch only as a local branch, and fetches nothing but master. */
const localOnly = () =>
  Effect.gen(function* () {
    yield* git(cloneA, "branch", "-q", BRANCH, `origin/${BRANCH}`);
    yield* git(
      cloneA,
      "config",
      "remote.origin.fetch",
      "+refs/heads/master:refs/remotes/origin/master",
    );
    yield* git(cloneA, "update-ref", "-d", `refs/remotes/origin/${BRANCH}`);
  });

test("a Stage on a branch its repository holds only locally asks the remote's head before working in the starting Run's checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      const started = yield* startedAt(`origin/${BRANCH}`);
      yield* localOnly();
      yield* advancedElsewhere();

      const checkout = yield* checkoutFor(herdrWith([agentIn(started, "idle")]), {
        cwd: cloneA,
        stateDir: rig.stateDir,
        name: "run-x",
        workflow: "stage",
        checkout: "branch",
        inputs: {},
        taskBranch: BRANCH,
        starting: { run: "run-implement", cwd: started },
      });

      expect(checkout.cwd).toBe(first);
      expect(checkout.note).toContain(
        `not working in ${started}, Run run-implement's checkout: it is not at ${BRANCH}'s head on origin`,
      );
    }),
  ));

test("whether a Stage on a branch held only locally would be refused asks the remote's head before counting on the starting Run's", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = yield* startedAt(`origin/${BRANCH}`);
      yield* localOnly();
      yield* advancedElsewhere();
      for (const held of [first, `${first}-2`, `${first}-3`]) {
        yield* fs.makeDirectory(held, { recursive: true });
        yield* fs.writeFileString(`${held}/kept`, "kept\n");
      }

      const refused = yield* checkoutRefusal(herdrWith([]), {
        cwd: cloneA,
        name: "run-x",
        inputs: {},
        taskBranch: BRANCH,
        recordedBy: () => Effect.succeed(null),
        starting: { run: "run-implement", cwd: started },
      });

      expect(refused).toContain("free one of them and retry");
    }),
  ));

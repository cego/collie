// A branch checkout whose path is already held: two clones of one remote with the same
// name want the same directory, and neither may be handed or harmed by the other's (#220).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runOnPath } from "./support/forge";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { Rig, FakeHerdr } from "./support/recorder";
import { checkoutFor, type RecordedBy } from "../src/worktree";

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

/** `git` that may fail, for questions whose answer is whether it did. */
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

/** Clone B's checkout of the branch at the first slot, as in the incident. */
const cloneBHoldsFirst = () => git(cloneB, "worktree", "add", "-q", first, BRANCH);

/** Every file under `dir` with its content, git's own directory left out. */
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

/** What a human would look at in a checkout to see that nobody touched it. */
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
              ? { run: "run-b", worktree: null, release: Effect.succeed("not taken") }
              : null,
          );

        const checkout = yield* ask(recordedBy);

        expect(checkout.refused).toBeNull();
        expect(checkout.cwd).toBe(`${first}-2`);
        expect(yield* git(checkout.cwd, "branch", "--show-current")).toBe(BRANCH);
        expect(yield* git(checkout.cwd, "rev-parse", "HEAD")).toBe(
          yield* git(origin, "rev-parse", BRANCH),
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

/** A git that takes the path it is asked to add a worktree at just before it adds one. */
const somebodyTakesTheSlot = Effect.fn("branchCheckoutTest.somebodyTakesTheSlot")(function* () {
  const real = Bun.which("git");
  const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (bin) => bin.restore());
  yield* bin.add(
    "git",
    `if [ "$1" = worktree ] && [ "$2" = add ]; then mkdir -p "$3" && echo theirs > "$3/file"; fi
exec "${real}" "$@"`,
  );
});

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

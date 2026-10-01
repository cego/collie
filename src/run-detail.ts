// One Run's details as the host serves a drawer: its diff, the large items a front door
// fetches by reference, and the details themselves followed as they change.

import { Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { HostRefused, RunDiff, type DiffFile, type RunDetail, type RunFile } from "./board-model";
import { shell } from "./mr";
import { settled, type RunFacts } from "./runs";
import { workSourceOf } from "./strategies";
import { readVerifications } from "./verify";

/** What a Run's own plan directory is called inside it (ADR-0002). */
const PLAN_DIR = "plan";

/** Which directory holds this run's plan, or `null` when it has none behind it. */
export const planDirOf = Effect.fn("RunDetail.planDirOf")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Its own copy first: a run that wrote a plan is building from that one.
  const own = path.join(run.dir, PLAN_DIR);
  if (yield* fs.exists(own)) return own;
  // Then the directory it was started from, which is how an `implement` run reaches the
  // spec a `plan` run wrote for it.
  const work = workSourceOf(run.settled);
  if (work?.kind !== "plan-dir") return null;
  return (yield* fs.exists(work.value)) ? work.value : null;
});

const git = (cwd: string, args: ReadonlyArray<string>) => shell("git", [...args], cwd);

/** NUL-separated, so a path git would otherwise quote comes back as it is on disk. */
const fields = (text: string) => text.split("\0").filter((field) => field !== "");

/** Where the Run's branch left the default branch, from the first default this checkout has. */
const mergeBase = Effect.fn("RunDetail.mergeBase")(function* (root: string, branch: string) {
  for (const base of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (base === branch) continue;
    const found = yield* git(root, ["merge-base", base, branch]);
    if (found.code === 0 && found.stdout.trim() !== "") return found.stdout.trim();
  }
  return null;
});

const statusOf = (code: string): DiffFile["status"] =>
  code === "A" ? "added" : code === "D" ? "deleted" : "modified";

/** An untracked file this big is listed without counting its lines. */
const COUNTED_BYTES = 1024 * 1024;

/** The checkout's top level, which every path git reports is relative to. */
const rootOf = Effect.fn("RunDetail.rootOf")(function* (cwd: string) {
  const there = yield* (yield* FileSystem.FileSystem)
    .exists(cwd)
    .pipe(Effect.orElseSucceed(() => false));
  if (!there) return null;
  const top = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.code === 0 ? top.stdout.trim() : null;
});

/**
 * The Run's branch against its merge base, one entry per file. Live is the checkout as it
 * is now, uncommitted and untracked files included; otherwise the branch's commits alone.
 * Null where there is no checkout or no merge base to compare with.
 */
export const runDiff = Effect.fn("RunDetail.runDiff")(function* (at: {
  readonly cwd: string;
  readonly branch: string;
  readonly live: boolean;
}) {
  if (at.branch.startsWith("-")) return null;
  const root = yield* rootOf(at.cwd);
  if (root === null) return null;
  const base = yield* mergeBase(root, at.branch);
  if (base === null) return null;
  const range = at.live ? [base] : [base, at.branch];
  const named = fields(
    (yield* git(root, ["diff", "-z", "--no-renames", "--name-status", ...range])).stdout,
  );
  const status = new Map<string, DiffFile["status"]>();
  for (let next = 0; next + 1 < named.length; next += 2)
    status.set(named[next + 1]!, statusOf(named[next]!));
  const files: DiffFile[] = fields(
    (yield* git(root, ["diff", "-z", "--no-renames", "--numstat", ...range])).stdout,
  ).map((field) => {
    const [added = "-", removed = "-", ...rest] = field.split("\t");
    const path = rest.join("\t");
    return {
      path,
      status: status.get(path) ?? "modified",
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    };
  });
  if (at.live) {
    const fs = yield* FileSystem.FileSystem;
    for (const path of fields(
      (yield* git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).stdout,
    )) {
      const size = yield* fs.stat(`${root}/${path}`).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => COUNTED_BYTES),
      );
      const text =
        size >= COUNTED_BYTES
          ? null
          : yield* fs.readFileString(`${root}/${path}`).pipe(Effect.orElseSucceed(() => ""));
      files.push({
        path,
        status: "added",
        added: text === null ? null : text.split("\n").filter((line) => line !== "").length,
        removed: text === null ? null : 0,
      });
    }
  }
  return {
    base,
    live: at.live,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  } satisfies RunDiff;
});

const DiffJson = Schema.fromJsonString(RunDiff);
const FINAL_DIFF = "diff.json";
const FINAL_PATCH = "diff.patch";

/**
 * The Run's own diff, where it has a branch to compare. Once the Run has ended the first
 * one read is kept in its directory, so a merged branch or a pruned checkout keeps it.
 */
export const diffOf = Effect.fn("RunDetail.diffOf")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const final = settled(run);
  if (final) {
    const kept = yield* fs
      .readFileString(`${run.dir}/${FINAL_DIFF}`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DiffJson)), Effect.option);
    if (kept._tag === "Some") return kept.value;
  }
  if (run.branch === null) return null;
  const diff = yield* runDiff({ cwd: run.cwd, branch: run.branch, live: !final });
  if (final && diff !== null) {
    const root = (yield* rootOf(run.cwd)) ?? run.cwd;
    const patch = yield* git(root, ["diff", "--no-renames", diff.base, run.branch]);
    yield* fs.writeFileString(`${run.dir}/${FINAL_PATCH}`, patch.stdout).pipe(Effect.ignore);
    yield* fs
      .writeFileString(`${run.dir}/${FINAL_DIFF}`, Schema.encodeSync(DiffJson)(diff))
      .pipe(Effect.ignore);
  }
  return diff;
});

/** One file's part of a whole patch, from its own `diff --git` header to the next. */
const fileOf = (patch: string, name: string) =>
  patch
    .split(/^(?=diff --git )/m)
    .find((part) => part.startsWith(`diff --git a/${name} b/${name}\n`)) ?? "";

/** Kept as text; anything else a front door is handed as base64. */
const TEXT = /\.(txt|log|md|json|jsonl|html|xml|csv|diff|patch|ts|tsx|js|yaml|yml|toml)$/;

const refused = (reason: string) => new HostRefused({ reason });

/** `relative` under `root` once every link is followed, or nothing where that leaves it. */
const inside = Effect.fn("RunDetail.inside")(function* (root: string, relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const top = yield* fs.realPath(root).pipe(Effect.option);
  const real = yield* fs.realPath(path.join(root, relative)).pipe(Effect.option);
  if (top._tag === "None" || real._tag === "None") return null;
  return real.value.startsWith(`${top.value}${path.sep}`) ? real.value : null;
});

/**
 * One large item of a Run's, by reference. Only what the Run's details point at can be
 * fetched, and never through a link out of the directory it belongs to.
 */
export const fetchRef = Effect.fn("RunDetail.fetchRef")(function* (
  run: RunFacts,
  ref: string,
): Effect.fn.Return<
  RunFile,
  HostRefused,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = (content: string): RunFile => ({ ref, encoding: "utf8", content });
  const read = (file: string) =>
    fs.readFile(file).pipe(
      Effect.mapError((cause) => refused(String(cause))),
      Effect.map((bytes): RunFile =>
        TEXT.test(file)
          ? text(new TextDecoder().decode(bytes))
          : { ref, encoding: "base64", content: Encoding.encodeBase64(bytes) },
      ),
    );
  const under = (root: string, name: string, what: string) =>
    inside(root, name).pipe(
      Effect.flatMap((file) =>
        file === null ? Effect.fail(refused(`${run.id} has no ${what} ${name}`)) : read(file),
      ),
    );
  const [kind, ...rest] = ref.split(":");
  const name = rest.join(":");
  switch (kind) {
    case "log":
      return text(
        yield* fs
          .readFileString(path.join(run.dir, "log.txt"))
          .pipe(Effect.orElseSucceed(() => "")),
      );
    case "diff": {
      const diff = yield* diffOf(run);
      const file = diff?.files.find((one) => one.path === name);
      if (diff === null || file === undefined)
        return yield* refused(`${name} is not in ${run.id}'s diff`);
      if (!diff.live) {
        const patch = yield* fs
          .readFileString(path.join(run.dir, FINAL_PATCH))
          .pipe(Effect.orElseSucceed(() => ""));
        return text(fileOf(patch, name));
      }
      const root = (yield* rootOf(run.cwd)) ?? run.cwd;
      const shown =
        file.status === "added"
          ? yield* git(root, ["diff", "--no-index", "--", "/dev/null", name])
          : yield* git(root, ["diff", "--no-renames", diff.base, "--", name]);
      return text(shown.stdout);
    }
    case "evidence":
      return yield* under(run.evidence, name, "evidence called");
    case "plan": {
      const dir = yield* planDirOf(run).pipe(Effect.orElseSucceed(() => null));
      if (dir === null) return yield* refused(`${run.id} has no plan`);
      return yield* under(dir, name, "plan file");
    }
    case "file": {
      const root = yield* rootOf(run.cwd);
      if (root === null) return yield* refused(`${run.id} has no checkout left to read`);
      return yield* under(root, name, "file");
    }
    case "verification": {
      const found = (yield* readVerifications(run.evidence).pipe(
        Effect.orElseSucceed(() => []),
      )).find((one) => one.id === name);
      if (found === undefined) return yield* refused(`${run.id} has no verification ${name}`);
      return text([found.tail.stdout, found.tail.stderr].filter((one) => one !== "").join("\n"));
    }
    default:
      return yield* refused(`${ref} is not a reference a Run's details hand out`);
  }
});

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The details now, then again each time `changed` says they may have moved, when they have. */
// ponytail: every change rebuilds the whole detail, its diff included; rebuild per part if open drawers cost.
export const followDetail = <E, R, R2>(
  build: Effect.Effect<RunDetail | null, E, R>,
  changed: Stream.Stream<unknown, never, R2>,
): Stream.Stream<RunDetail | null, E, R | R2> =>
  Stream.concat(Stream.make(undefined), changed).pipe(
    Stream.mapEffect(() => build),
    Stream.changesWith((a, b) => asJson(a) === asJson(b)),
  );

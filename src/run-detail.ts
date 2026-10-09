// One Run's details as the host serves a drawer: its diff, the large items a front door
// fetches by reference, and the details themselves followed as they change.

import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import * as Base64 from "effect/encoding/Base64";
import type { ChildProcessSpawner } from "effect/process";
import {
  HostRefused,
  PART_BYTES,
  RunDiff,
  type DiffFile,
  type RunDetail,
  type RunFile,
} from "./board-model";
import { attachmentsDir } from "./attachments";
import { classifyWorkSource } from "./inputs";
import { pipelineStatus, shell } from "./mr";
import { REVIEW_FILE } from "./output";
import { settled, type RunFacts } from "./runs";
import { workSourceOf } from "./strategies";
import { readVerifications } from "./verify";

/** What a Run's own plan directory is called inside it (ADR-0002). */
export const PLAN_DIR = "plan";

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
  if (work === null) return null;
  // A start that recorded no kind, as one from a plan's end menu, is classified as the engine does.
  const kind =
    work.kind !== ""
      ? work.kind
      : yield* classifyWorkSource(work.value).pipe(
          Effect.map((found) => found.kind),
          Effect.orElseSucceed(() => "text"),
        );
  if (kind !== "plan-dir") return null;
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
      const file = `${root}/${path}`;
      // Never through a link or into a device or FIFO: an agent's checkout is untrusted.
      const linked = yield* fs.readLink(file).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const size = linked
        ? COUNTED_BYTES
        : yield* fs.stat(file).pipe(
            Effect.map((info) => (info.type === "File" ? Number(info.size) : COUNTED_BYTES)),
            Effect.orElseSucceed(() => COUNTED_BYTES),
          );
      const text =
        size >= COUNTED_BYTES
          ? null
          : yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
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

/** A settled Run's diff and each file's patch, with the branch head it was taken at. */
const KeptJson = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.String,
    diff: RunDiff,
    patches: Schema.Record(Schema.String, Schema.String),
  }),
);
export const FINAL_DIFF = "diff.json";

/** The patch the first part of a `diff:` item was cut from, so its later parts reuse it. */
// ponytail: the last one only; key by front door if two drawers page large diffs at once.
let lastPatch: { readonly key: string; readonly text: string } | null = null;

/** Paths taken as written: a name with `[` or `*` in it is no glob. */
const literally = (root: string, args: ReadonlyArray<string>) =>
  git(root, ["--literal-pathspecs", ...args]);

const readKept = (dir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/${FINAL_DIFF}`)),
    Effect.flatMap(Schema.decodeUnknownEffect(KeptJson)),
    Effect.option,
  );

const headOf = Effect.fn("RunDetail.headOf")(function* (cwd: string, branch: string) {
  const root = yield* rootOf(cwd);
  if (root === null || branch.startsWith("-")) return null;
  const head = yield* git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  return head.code === 0 ? head.stdout.trim() : null;
});

/**
 * The Run's own diff, where it has a branch to compare. A settled Run's is kept in its
 * directory with the head it was taken at, so a merged branch or a pruned checkout keeps
 * it, and a resumed Run that committed more is read again.
 */
export const diffOf = Effect.fn("RunDetail.diffOf")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const final = settled(run);
  if (run.branch === null) return null;
  const head = final ? yield* headOf(run.cwd, run.branch) : null;
  if (final) {
    const kept = yield* readKept(run.dir);
    if (kept._tag === "Some" && (head === null || kept.value.head === head)) return kept.value.diff;
  }
  const diff = yield* runDiff({ cwd: run.cwd, branch: run.branch, live: !final });
  if (head !== null && diff !== null) {
    const root = (yield* rootOf(run.cwd)) ?? run.cwd;
    const patches: Record<string, string> = {};
    // ponytail: one git call per file, once each time the Run settles.
    for (const file of diff.files) {
      const args = ["diff", "--no-renames", diff.base, run.branch, "--", file.path];
      patches[file.path] = (yield* literally(root, args)).stdout;
    }
    yield* fs
      .writeFileString(
        `${run.dir}/${FINAL_DIFF}`,
        Schema.encodeSync(KeptJson)({ head, diff, patches }),
      )
      .pipe(Effect.ignore);
  }
  return diff;
});

/** Each Run's diff, kept once each time it settles, while its branch is still there to read. */
export const keepDiffs = Effect.fn("RunDetail.keepDiffs")(function* (
  runs: ReadonlyArray<RunFacts>,
  kept: Set<string>,
) {
  for (const run of runs) {
    // Going again after a resume: what it settles with next is kept afresh.
    if (!settled(run)) kept.delete(run.id);
    else if (run.branch !== null && !kept.has(run.id)) {
      yield* diffOf(run);
      kept.add(run.id);
    }
  }
});

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
  range: { readonly offset: number; readonly length: number } = {
    offset: 0,
    length: PART_BYTES,
  },
  /** Where glab runs: not the Run's checkout, which is removed once the Run settles. */
  glabCwd: string = run.dir,
): Effect.fn.Return<
  RunFile,
  HostRefused,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const part = {
    offset: Math.max(0, range.offset),
    length: Math.min(Math.max(0, range.length), PART_BYTES),
  };
  const fs = yield* FileSystem.FileSystem;
  // A part of a text is bytes too: a character across the seam is whole once the parts are joined.
  const asked = (bytes: Uint8Array, size: number, file: string | null): RunFile =>
    bytes.length === size && (file === null || TEXT.test(file))
      ? { ref, encoding: "utf8", content: new TextDecoder().decode(bytes), size }
      : { ref, encoding: "base64", content: Base64.encode(bytes), size };
  const text = (content: string): RunFile => {
    const bytes = new TextEncoder().encode(content);
    return asked(bytes.subarray(part.offset, part.offset + part.length), bytes.length, null);
  };
  // Only the part asked for, and only from a regular file: a FIFO or device never answers.
  const read = (file: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const info = yield* fs.stat(file);
        if (info.type !== "File") return yield* refused(`${ref} is not a file`);
        const size = Number(info.size);
        const handle = yield* fs.open(file, { flag: "r" });
        yield* handle.seek(BigInt(part.offset), "start");
        const bytes = yield* handle.readAlloc(
          Math.max(0, Math.min(part.length, size - part.offset)),
        );
        return asked(
          Option.getOrElse(bytes, () => new Uint8Array()),
          size,
          file,
        );
      }),
    ).pipe(
      Effect.mapError((cause) => (Schema.is(HostRefused)(cause) ? cause : refused(String(cause)))),
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
      return yield* under(run.dir, "log.txt", "log").pipe(
        Effect.catch(() => Effect.succeed(text(""))),
      );
    case "diff": {
      const key = `${run.id}|${name}`;
      if (part.offset > 0 && lastPatch?.key === key) return text(lastPatch.text);
      const patch = (content: string) => {
        lastPatch = { key, text: content };
        return text(content);
      };
      const diff = yield* diffOf(run);
      const file = diff?.files.find((one) => one.path === name);
      if (diff === null || file === undefined)
        return yield* refused(`${name} is not in ${run.id}'s diff`);
      if (!diff.live) {
        const kept = yield* readKept(run.dir);
        return patch(kept._tag === "Some" ? (kept.value.patches[name] ?? "") : "");
      }
      const root = (yield* rootOf(run.cwd)) ?? run.cwd;
      const shown =
        file.status === "added"
          ? yield* git(root, ["diff", "--no-index", "--", "/dev/null", name])
          : yield* literally(root, ["diff", "--no-renames", diff.base, "--", name]);
      return patch(shown.stdout);
    }
    case "pipeline": {
      const status = yield* pipelineStatus(name, glabCwd, shell);
      return status === null ? yield* refused(`GitLab did not say how ${name} went`) : text(status);
    }
    case "review":
      return yield* under(run.dir, REVIEW_FILE, "review");
    case "evidence":
      return yield* under(run.evidence, name, "evidence called");
    case "attachment":
      return yield* under(attachmentsDir(run.dir), name, "attachment");
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

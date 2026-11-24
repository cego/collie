import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Path, Schema, Stream, flow, Result } from "effect";
import * as Base64 from "effect/encoding/Base64";
import { HostRefused, PART_BYTES, RunDiff } from "./board-model";
import type { DiffFile, RunFile } from "./board-model";
import { attachmentsDir } from "./attachments";
import { handoffsDir } from "./handoffs";
import { classifyWorkSource } from "./inputs";
import { shell } from "./mr";
import { forgeOfUrl } from "./forge/forge";
import { REVIEW_FILE } from "./output";
import { settled } from "./runs";
import type { RunFacts } from "./runs";
import { workSourceOf } from "./strategies";
import { readVerifications } from "./verify";

export const PLAN_DIR = "plan";

export const planDirOf = Effect.fn("RunDetail.planDirOf")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own = path.join(run.dir, PLAN_DIR);
  if (yield* fs.exists(own)) {
    return own;
  }
  const work = workSourceOf(run.settled);
  if (work === null) {
    return null;
  }
  const kind =
    work.kind !== ""
      ? work.kind
      : yield* classifyWorkSource(work.value).pipe(
          Effect.map((found) => found.kind),
          Effect.orElseSucceed(() => "text"),
        );
  if (kind !== "plan-dir") {
    return null;
  }
  return (yield* fs.exists(work.value)) ? work.value : null;
});

const git = (cwd: string, args: ReadonlyArray<string>) => shell("git", [...args], cwd);

// WARNING: NUL-separated, so git's quoted paths come back as they are on disk.
const fields = (text: string) => Arr.filter(Str.split(text, "\0"), (field) => field !== "");

const mergeBase = Effect.fn("RunDetail.mergeBase")(function* (root: string, branch: string) {
  for (const base of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (base === branch) {
      continue;
    }
    const found = yield* git(root, ["merge-base", base, branch]);
    if (found.code === 0 && Str.trim(found.stdout) !== "") {
      return Str.trim(found.stdout);
    }
  }
  return null;
});

const statusOf = (code: string) => (code === "A" ? "added" : code === "D" ? "deleted" : "modified");

const COUNTED_BYTES = 1024 * 1024;

const rootOf = Effect.fn("RunDetail.rootOf")(function* (cwd: string) {
  const there = yield* (yield* FileSystem.FileSystem)
    .exists(cwd)
    .pipe(Effect.orElseSucceed(() => false));
  if (!there) {
    return null;
  }
  const top = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.code === 0 ? Str.trim(top.stdout) : null;
});

export const runDiff = Effect.fn("RunDetail.runDiff")(function* (at: {
  readonly cwd: string;
  readonly branch: string;
  readonly live: boolean;
}) {
  if (pipe_(at.branch, Str.startsWith("-"))) {
    return null;
  }
  const root = yield* rootOf(at.cwd);
  if (root === null) {
    return null;
  }
  const base = yield* mergeBase(root, at.branch);
  if (base === null) {
    return null;
  }
  const range = at.live ? [base] : [base, at.branch];
  const named = fields(
    (yield* git(root, ["diff", "-z", "--no-renames", "--name-status", ...range])).stdout,
  );
  const status = new Map<string, DiffFile["status"]>();
  for (let next = 0; next + 1 < named.length; next += 2) {
    status.set(named[next + 1]!, statusOf(named[next]!));
  }
  const files: Array<DiffFile> = Arr.map(
    fields((yield* git(root, ["diff", "-z", "--no-renames", "--numstat", ...range])).stdout),
    (field) => {
      const [added, removed = "-", ...rest] = Str.split(field, "\t");
      const path = Arr.join(rest, "\t");
      return {
        path,
        status: status.get(path) ?? "modified",
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      };
    },
  );
  if (at.live) {
    const fs = yield* FileSystem.FileSystem;
    for (const path of fields(
      (yield* git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).stdout,
    )) {
      const file = `${root}/${path}`;
      // WARNING: never through a link, device or FIFO: an agent's checkout is untrusted.
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
        added:
          text === null ? null : Arr.filter(Str.split(text, "\n"), (line) => line !== "").length,
        removed: text === null ? null : 0,
      });
    }
  }
  return {
    base,
    live: at.live,
    files: files.sort((a, b) => pipe_(a.path, Str.localeCompare(b.path))),
  } satisfies RunDiff;
});

const KeptJson = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.String,
    diff: RunDiff,
    patches: Schema.Record(Schema.String, Schema.String),
  }),
);
export const FINAL_DIFF = "diff.json";

let lastPatch: { readonly key: string; readonly text: string } | null = null;

// WARNING: paths are literal: a `[` or `*` in a name is not a glob.
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
  if (root === null || pipe_(branch, Str.startsWith("-"))) {
    return null;
  }
  const head = yield* git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  return head.code === 0 ? Str.trim(head.stdout) : null;
});

export const diffOf = Effect.fn("RunDetail.diffOf")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const final = settled(run);
  if (run.branch === null) {
    return null;
  }
  const head = final ? yield* headOf(run.cwd, run.branch) : null;
  if (final) {
    const kept = yield* readKept(run.dir);
    if (kept._tag === "Some" && (head === null || kept.value.head === head)) {
      return kept.value.diff;
    }
  }
  const diff = yield* runDiff({ cwd: run.cwd, branch: run.branch, live: !final });
  if (head !== null && diff !== null) {
    const root = (yield* rootOf(run.cwd)) ?? run.cwd;
    const patches: Record<string, string> = {};
    for (const file of diff.files) {
      const args = ["diff", "--no-renames", diff.base, run.branch, "--", file.path];
      patches[file.path] = (yield* literally(root, args)).stdout;
    }
    yield* fs
      .writeFileString(
        `${run.dir}/${FINAL_DIFF}`,
        yield* Schema.encodeEffect(KeptJson)({ head, diff, patches }).pipe(Effect.orDie),
      )
      .pipe(Effect.ignore);
  }
  return diff;
});

export const keepDiffs = Effect.fn("RunDetail.keepDiffs")(function* (
  runs: ReadonlyArray<RunFacts>,
  kept: Set<string>,
) {
  for (const run of runs) {
    if (!settled(run)) {
      kept.delete(run.id);
    } else if (run.branch !== null && !kept.has(run.id)) {
      yield* diffOf(run);
      kept.add(run.id);
    }
  }
});

const TEXT = /\.(txt|log|md|json|jsonl|html|xml|csv|diff|patch|ts|tsx|js|yaml|yml|toml)$/;

const refused = (reason: string) => new HostRefused({ reason });

const inside = Effect.fn("RunDetail.inside")(function* (root: string, relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const top = yield* fs.realPath(root).pipe(Effect.option);
  const real = yield* fs.realPath(path.join(root, relative)).pipe(Effect.option);
  if (top._tag === "None" || real._tag === "None") {
    return null;
  }
  return pipe_(real.value, Str.startsWith(`${top.value}${path.sep}`)) ? real.value : null;
});

export const fetchRef = Effect.fn("RunDetail.fetchRef")(function* (
  run: RunFacts,
  ref: string,
  range: { readonly offset: number; readonly length: number } = {
    offset: 0,
    length: PART_BYTES,
  },
  // WARNING: not the Run's checkout, which is removed once the Run settles.
  glabCwd: string = run.dir,
) {
  const part = {
    offset: Math.max(0, range.offset),
    length: Math.min(Math.max(0, range.length), PART_BYTES),
  };
  const fs = yield* FileSystem.FileSystem;
  // WARNING: parts are bytes, so a character across a seam is whole only once joined.
  const asked: (bytes: Uint8Array, size: number, file: string | null) => RunFile = (
    bytes,
    size,
    file,
  ) =>
    bytes.length === size && (file === null || TEXT.test(file))
      ? { ref, encoding: "utf8", content: new TextDecoder().decode(bytes), size }
      : { ref, encoding: "base64", content: Base64.encode(bytes), size };
  const text = (content: string) => {
    const bytes = new TextEncoder().encode(content);
    return asked(bytes.subarray(part.offset, part.offset + part.length), bytes.length, null);
  };
  // WARNING: only regular files: a FIFO or device would never answer.
  const read = (file: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const info = yield* fs.stat(file);
        if (info.type !== "File") {
          return yield* refused(`${ref} is not a file`);
        }
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
  const [kind, ...rest] = Str.split(ref, ":");
  const name = Arr.join(rest, ":");
  switch (kind) {
    case "log":
      return yield* under(run.dir, "log.txt", "log").pipe(Effect.orElseSucceed(() => text("")));
    case "diff": {
      const key = `${run.id}|${name}`;
      if (part.offset > 0 && lastPatch?.key === key) {
        return text(lastPatch.text);
      }
      const patch = (content: string) => {
        lastPatch = { key, text: content };
        return text(content);
      };
      const diff = yield* diffOf(run);
      const file = Option.getOrUndefined(
        Option.map(Option.fromNullishOr(diff), (present) =>
          Option.getOrUndefined(Arr.findFirst(present.files, (one) => one.path === name)),
        ),
      );
      if (diff === null || file === undefined) {
        return yield* refused(`${name} is not in ${run.id}'s diff`);
      }
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
      const forge = forgeOfUrl(name);
      const status = yield* forge.runStatus(name, glabCwd, shell);
      return status === null
        ? yield* refused(`${forge.display} did not say how ${name} went`)
        : text(status);
    }
    case "review":
      return yield* under(run.dir, REVIEW_FILE, "review");
    case "evidence":
      return yield* under(run.evidence, name, "evidence called");
    case "attachment":
      return yield* under(attachmentsDir(run.dir), name, "attachment");
    case "handoff":
      return yield* under(handoffsDir(run.dir), name, "handoff note");
    case "plan": {
      const dir = yield* planDirOf(run).pipe(Effect.orElseSucceed(() => null));
      if (dir === null) {
        return yield* refused(`${run.id} has no plan`);
      }
      return yield* under(dir, name, "plan file");
    }
    case "file": {
      const root = yield* rootOf(run.cwd);
      if (root === null) {
        return yield* refused(`${run.id} has no checkout left to read`);
      }
      return yield* under(root, name, "file");
    }
    case "verification": {
      const found = Option.getOrUndefined(
        Arr.findFirst(
          yield* readVerifications(run.evidence).pipe(Effect.orElseSucceed(() => [])),
          (one) => one.id === name,
        ),
      );
      if (found === undefined) {
        return yield* refused(`${run.id} has no verification ${name}`);
      }
      return text(
        Arr.join(
          Arr.filter([found.tail.stdout, found.tail.stderr], (one) => one !== ""),
          "\n",
        ),
      );
    }
    default:
      return yield* refused(`${ref} is not a reference a Run's details hand out`);
  }
});

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

export const followDetail = <A, E, R, R2>(
  build: Effect.Effect<A, E, R>,
  changed: Stream.Stream<unknown, never, R2>,
) =>
  Stream.concat(Stream.make(undefined), changed).pipe(
    Stream.mapEffect(() => build),
    Stream.changesWith((a, b) => asJson(a) === asJson(b)),
  );

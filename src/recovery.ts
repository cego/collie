import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Order from "effect/Order";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { defaultBase, classifyWorkSource } from "./inputs";
import { readIntent } from "./intent";
import { isBlocking, SynthesisSchema, FindingSchema } from "./output";
import { sameTree, treeOf } from "./verify";
import { appendJournal, readJournalWhole } from "./journal";
import { readCards } from "./cards";
import { shell } from "./mr";
import { nowIso } from "./time";

export const ReviewScope = Schema.Struct({
  source: Schema.String,
  requirements: Schema.String,
  target: Schema.String,
  head: Schema.String,
  fingerprint: Schema.String,
  outcome: Schema.String,
  risks: Schema.String,
});
export type ReviewScope = typeof ReviewScope.Type;
const ReviewedWork = Schema.Struct({
  ...ReviewScope.fields,
  base: Schema.String,
  at: Schema.String,
  review: SynthesisSchema,
});
const ReviewedJson = Schema.fromJsonString(ReviewedWork);
export const Recovery = Schema.Struct({
  implementation: Schema.Boolean,
  reason: Schema.String,
  previous: Schema.String,
  commits: Schema.String,
  review: Schema.NullOr(SynthesisSchema),
});
export type Recovery = typeof Recovery.Type;
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

export const reviewScope = Effect.fn("Recovery.reviewScope")(
  function* (cwd: string, dir: string, source: string, outcome = "", risks = "") {
    const fs = yield* FileSystem.FileSystem;
    const classified = yield* classifyWorkSource(source);
    let content = source;
    if (classified.kind === "plan-dir" || classified.kind === "review") {
      const names =
        classified.kind === "review"
          ? ["review.md", "findings.json"]
          : [
              "SPEC.md",
              ...Arr.map(
                Arr.sort(
                  yield* fs.readDirectory(`${source}/issues`).pipe(Effect.orElseSucceed(() => [])),
                  Str.Order,
                ),
                (name) => `issues/${name}`,
              ),
            ];
      content = encode(
        yield* Effect.forEach(names, (name) =>
          fs.readFileString(`${source}/${name}`).pipe(Effect.map((text) => [name, text])),
        ),
      );
    }
    const intent = yield* readIntent(dir);
    const proves = intent?.outcome ?? (outcome || "unspecified");
    const requirements = encode({
      source,
      content,
      goal: intent?.goal ?? null,
      outcome: proves,
      risks,
      constraints: Arr.map(intent?.constraints ?? [], (one) => [one.text, one.severity]),
    });
    const branch = yield* defaultBase(shell, cwd);
    const target =
      branch === null
        ? null
        : yield* shell("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], cwd);
    const tree = yield* treeOf(cwd);
    if (tree.dirty || target === null || target.code !== 0) return null;
    const targetHead = Str.split(Str.trim(target.stdout), /\s/)[0] ?? "";
    if ((yield* shell("git", ["fetch", "-q", "origin", targetHead], cwd)).code !== 0) return null;
    return {
      source,
      requirements,
      target: targetHead,
      head: tree.head_sha,
      fingerprint: tree.fingerprint,
      outcome: proves,
      risks,
    } satisfies ReviewScope;
  },
  Effect.orElseSucceed(() => null),
);

export const recordReview = Effect.fn("Recovery.recordReview")(function* (
  cwd: string,
  dir: string,
  scope: ReviewScope | null,
  base: string,
  review: typeof SynthesisSchema.Type,
) {
  if (scope === null) return;
  const now = yield* reviewScope(cwd, dir, scope.source, scope.outcome, scope.risks);
  if (
    now === null ||
    now.requirements !== scope.requirements ||
    now.target !== scope.target ||
    now.head !== scope.head ||
    !sameTree(now, scope)
  )
    return;
  yield* appendJournal(`${dir}/reviews.jsonl`, ReviewedJson, {
    ...scope,
    base,
    review,
    at: yield* nowIso,
  });
});

export const takePushed = Effect.fn("Recovery.takePushed")(function* (cwd: string) {
  const tree = yield* treeOf(cwd);
  if (tree.dirty || tree.branch === null || tree.branch === "HEAD")
    return "Recovery needs a clean checkout on its branch.";
  const git = (...args: string[]) => shell("git", args, cwd);
  const read = yield* git("ls-remote", "--exit-code", "origin", `refs/heads/${tree.branch}`);
  if (read.code !== 0) return "The pushed branch cannot be read.";
  const head = Str.split(Str.trim(read.stdout), /\s/)[0] ?? "";
  if (head === tree.head_sha) return null;
  if ((yield* git("fetch", "-q", "origin", head)).code !== 0)
    return "The pushed branch could not be fetched.";
  if ((yield* git("merge-base", "--is-ancestor", tree.head_sha, head)).code !== 0)
    return "The checkout and pushed branch diverged, or the checkout has unpublished commits; recovery cannot take the pushed head safely.";
  const moved = yield* git("merge", "--ff-only", head);
  return moved.code === 0 ? null : "The checkout could not fast-forward to the pushed head.";
});

export const recoveryFrom = Effect.fn("Recovery.from")(
  function* (options: {
    readonly cwd: string;
    readonly dir: string;
    readonly parent: string;
    readonly candidates: ReadonlyArray<string>;
    readonly source: string;
    readonly outcome: string;
    readonly risks: string;
  }) {
    const build: Recovery = {
      implementation: false,
      reason: "No implementation is established safely.",
      previous: "",
      commits: "",
      review: null,
    };
    let current = yield* reviewScope(
      options.cwd,
      options.dir,
      options.source,
      options.outcome,
      options.risks,
    );
    if (current === null) return build;
    const git = (...args: string[]) => shell("git", args, options.cwd);
    const pushed = yield* git(
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${Str.trim((yield* git("branch", "--show-current")).stdout)}`,
    );
    const remote = Str.split(Str.trim(pushed.stdout), /\s/)[0] ?? "";
    if (pushed.code !== 0) return { ...build, reason: "The pushed branch cannot be read." };
    if (remote !== current.head) {
      if (
        (yield* git("fetch", "-q", "origin", remote)).code !== 0 ||
        (yield* git("merge-base", "--is-ancestor", current.head, remote)).code !== 0
      )
        return {
          ...build,
          reason: "The checkout and pushed branch diverged or contain unpublished work.",
        };
      const tree = yield* git("rev-parse", `${remote}^{tree}`);
      if (tree.code !== 0) return build;
      current = { ...current, head: remote, fingerprint: Str.trim(tree.stdout) };
    }
    const readings = yield* Effect.forEach(options.candidates, (dir) =>
      readJournalWhole(`${dir}/reviews.jsonl`, ReviewedJson),
    );
    const records = Arr.sort(
      Arr.flatMap(readings, (one) => one.lines),
      Order.mapInput(Str.Order, (one: typeof ReviewedWork.Type) => one.at),
    );
    const finals = yield* readCards(options.parent).pipe(Effect.orElseSucceed(() => []));
    const final = Arr.findLast(finals, (one) => one.kind === "final");
    const prior = Arr.findLast(records, (one) => one.source === options.source);
    const previous =
      prior._tag === "Some"
        ? prior.value.head
        : final._tag === "Some"
          ? final.value.revision.head_sha
          : "";
    if (
      final._tag === "Some" &&
      (yield* git("merge-base", "--is-ancestor", final.value.revision.head_sha, current.head))
        .code !== 0
    )
      return { ...build, reason: "The finished branch history diverged or was force-pushed." };
    if (
      previous !== "" &&
      (yield* git("merge-base", "--is-ancestor", previous, current.head)).code !== 0
    )
      return {
        ...build,
        reason: "The branch diverged or was force-pushed; forward progress is unproved.",
      };
    const diff = yield* git("rev-list", "--count", `${current.target}..${current.head}`);
    if (diff.code !== 0 || Number(Str.trim(diff.stdout)) < 1) return build;
    const commits =
      previous === ""
        ? ""
        : Str.trim((yield* git("log", "--format=%H %s", `${previous}..${current.head}`)).stdout);
    const clean = Arr.findLast(
      records,
      (one) =>
        one.source === options.source &&
        one.requirements === current.requirements &&
        one.head === current.head &&
        one.fingerprint === current.fingerprint &&
        one.target === current.target,
    );
    const fs = yield* FileSystem.FileSystem;
    const findings = `${options.parent}/findings.json`;
    const blocking = (yield* fs.exists(findings))
      ? Arr.some(
          yield* fs
            .readFileString(findings)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(FindingSchema))),
              ),
            ),
          isBlocking,
        )
      : false;
    // shortcut: external issue bodies need review until the host can snapshot them.
    const external = (yield* classifyWorkSource(options.source)).kind === "linear";
    const judgement = (review: typeof SynthesisSchema.Type) => {
      switch (current.outcome) {
        case "feature":
          return review.scope_met === true;
        case "refactor":
          return review.behavior_preserved === true;
        case "investigation":
          return review.supported === true;
        case "docs":
          return review.accurate === true;
        case "migration":
          return review.compatible === true;
        default:
          return review.scope_met !== false;
      }
    };
    if (
      clean._tag === "Some" &&
      !external &&
      Arr.every(readings, (one) => one.corrupt === 0) &&
      !blocking &&
      clean.value.review.verdict === "clean" &&
      judgement(clean.value.review) &&
      !Arr.some(
        [...clean.value.review.findings, ...(clean.value.review.disputed ?? [])],
        isBlocking,
      )
    )
      return {
        implementation: true,
        reason: "A completed clean review settles these requirements at the pushed head.",
        previous,
        commits,
        review: clean.value.review,
      } satisfies Recovery;
    return {
      implementation: true,
      reason: "Implementation is pushed; its current requirements and diff need review.",
      previous,
      commits,
      review: null,
    } satisfies Recovery;
  },
  Effect.orElseSucceed((): Recovery => ({
    implementation: false,
    reason: "Branch or review records are unreadable.",
    previous: "",
    commits: "",
    review: null,
  })),
);

export const branchMovement = Effect.fn("Recovery.branchMovement")(function* (run: {
  readonly cwd: string;
  readonly dir: string;
  readonly branch: string | null;
  readonly state: string;
}) {
  if (run.branch === null || !["succeeded", "failed"].includes(run.state)) return null;
  const final = Arr.findLast(
    yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => [])),
    (card) => card.kind === "final",
  );
  if (final._tag === "None" || final.value.revision.head_sha === "") return null;
  const finished = final.value.revision.head_sha;
  const read = yield* shell(
    "git",
    ["ls-remote", "--exit-code", "origin", `refs/heads/${run.branch}`],
    run.cwd,
  );
  if (read.code !== 0) return "Pushed branch head unavailable; the finished record is unchanged.";
  const head = Str.split(Str.trim(read.stdout), /\s/)[0] ?? "";
  if (head === finished) return null;
  const fetched = yield* shell("git", ["fetch", "-q", "origin", head], run.cwd);
  const ancestry =
    fetched.code === 0
      ? yield* shell("git", ["merge-base", "--is-ancestor", finished, head], run.cwd)
      : fetched;
  if (ancestry.code !== 0)
    return `Pushed branch diverged or was force-pushed: ${finished} → ${head}; forward progress is unproved.`;
  const count = yield* shell("git", ["rev-list", "--count", `${finished}..${head}`], run.cwd);
  if (count.code !== 0) return `Pushed branch history unavailable at ${head}.`;
  const n = Str.trim(count.stdout);
  return `Pushed branch: ${n} commit${n === "1" ? "" : "s"} past ${finished}, now ${head}.${run.state === "failed" ? " The failed record is stale." : " The succeeded record describes the earlier head."}`;
});

// WARNING: append-only: a revision, a pin or a post is never rewritten, so an older link keeps opening what it recorded.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { sha256Hex } from "./attachments";
import { criteriaEvidence, passingAt } from "./hand-over";
import type { Criterion } from "./output";
import type { Verification } from "./verify";
import { orderedTickets } from "./plan";
import type { SpecTicket } from "./task-spec";
import { objectiveIn, doneIn, requirementsIn, ticketsInSpec } from "./task-spec";
import { afterMergeIn } from "./plan";
import { readTask } from "./task";
import { TASKS } from "./task";
import { nowIso } from "./time";
import { FileSystem, Path } from "effect";

const Actor = Schema.Struct({
  by: Schema.String,
  kind: Schema.Literals(["human", "agent", "host"]),
});
export type Actor = typeof Actor.Type;

const SpecSource = Schema.Struct({
  // WARNING: adopted is a Run's plan as it stood; edit is the revision its editor saw.
  kind: Schema.Literals(["run", "edit"]),
  run: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  planDigest: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.Finite),
});

const TicketSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  criteria: Schema.Array(Schema.String),
  afterMerge: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
  text: Schema.String,
});

export const TaskSpecSchema = Schema.Struct({
  task: Schema.String,
  revision: Schema.Finite,
  at: Schema.String,
  actor: Schema.String,
  rationale: Schema.NullOr(Schema.String),
  text: Schema.String,
  tickets: Schema.Array(TicketSchema),
  source: Schema.NullOr(SpecSource),
  digest: Schema.String,
});

export const TaskPinSchema = Schema.Struct({
  run: Schema.String,
  task: Schema.String,
  revision: Schema.Finite,
  at: Schema.String,
  digest: Schema.String,
  // WARNING: the words the agent was admitted with, kept here so an amendment cannot rewrite them.
  briefing: Schema.String,
});

const PostSource = Schema.Struct({
  kind: Schema.Literals(["run", "agent", "review", "answer", "spec", "plan", "decision"]),
  run: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  machine: Schema.optionalKey(Schema.NullOr(Schema.String)),
  revision: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  decision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  report: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const TaskPostSchema = Schema.Struct({
  task: Schema.String,
  seq: Schema.Finite,
  id: Schema.String,
  kind: Schema.Literals([
    "comment",
    "decision",
    "challenge",
    "resolution",
    "run_started",
    "run_ended",
    "review",
    "answer",
    "adopted",
    "amended",
  ]),
  at: Schema.String,
  actor: Actor,
  text: Schema.String,
  source: Schema.NullOr(PostSource),
  about: Schema.Array(Schema.String),
  // WARNING: a post that asks something is only closed by a resolution naming it.
  question: Schema.Boolean,
});

export type TaskSpec = Schema.Schema.Type<typeof TaskSpecSchema>;
export type TaskPin = Schema.Schema.Type<typeof TaskPinSchema>;
export type TaskPost = Schema.Schema.Type<typeof TaskPostSchema>;

const SpecJson = Schema.fromJsonString(TaskSpecSchema);
const PinJson = Schema.fromJsonString(TaskPinSchema);
const PostJson = Schema.fromJsonString(TaskPostSchema);
const encodeSpec = flow(Schema.encodeResult(SpecJson), Result.getOrThrow);
const encodePin = flow(Schema.encodeResult(PinJson), Result.getOrThrow);
const encodePost = flow(Schema.encodeResult(PostJson), Result.getOrThrow);
const decodeSpec = Schema.decodeOption(SpecJson);
const decodePin = Schema.decodeOption(PinJson);
const decodePost = Schema.decodeOption(PostJson);

export const TASK_CONTEXT = "collie/task-context";

export interface ContextApi {
  readonly revisions: (task: string) => Effect.Effect<ReadonlyArray<TaskSpec>>;
  readonly revision: (task: string, revision: number) => Effect.Effect<TaskSpec | null>;
  readonly append: (spec: TaskSpec) => Effect.Effect<TaskSpec>;
  readonly pin: (pin: TaskPin) => Effect.Effect<TaskPin>;
  readonly pinned: (run: string) => Effect.Effect<TaskPin | null>;
  readonly posts: (
    task: string,
    limit: number,
    before: number | null,
  ) => Effect.Effect<ReadonlyArray<TaskPost>>;
  readonly add: (post: TaskPost) => Effect.Effect<TaskPost | null>;
}

export class TaskContext extends Context.Service<TaskContext, ContextApi>()("collie/TaskContext") {}

const specsOf = (rows: ReadonlyArray<{ readonly record: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeSpec(row.record)));

export const taskContextLayer = Layer.effect(TaskContext)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const changed = reactivity.invalidate([TASK_CONTEXT, TASKS]);
    return {
      revisions: (task) =>
        sql<{ readonly record: string }>`
          SELECT record FROM collie_task_specs WHERE task = ${task} ORDER BY revision
        `.pipe(Effect.map(specsOf), Effect.orDie),
      revision: (task, revision) =>
        sql<{ readonly record: string }>`
          SELECT record FROM collie_task_specs WHERE task = ${task} AND revision = ${revision}
        `.pipe(
          Effect.map((rows) => specsOf(rows)[0] ?? null),
          Effect.orDie,
        ),
      append: (spec) =>
        sql`
          INSERT INTO collie_task_specs (task, revision, record, at)
          VALUES (${spec.task}, ${spec.revision}, ${encodeSpec(spec)}, ${spec.at})
        `.pipe(Effect.andThen(changed), Effect.as(spec), Effect.orDie),
      pin: (pin) =>
        sql`
          INSERT INTO collie_task_pins (run, task, revision, record)
          VALUES (${pin.run}, ${pin.task}, ${pin.revision}, ${encodePin(pin)})
          ON CONFLICT (run) DO NOTHING
        `.pipe(Effect.andThen(changed), Effect.as(pin), Effect.orDie),
      pinned: (run) =>
        sql<{ readonly record: string }>`
          SELECT record FROM collie_task_pins WHERE run = ${run}
        `.pipe(
          Effect.map((rows) => Option.getOrNull(decodePin(rows[0]?.record ?? ""))),
          Effect.orDie,
        ),
      posts: (task, limit, before) =>
        sql<{ readonly record: string }>`
          SELECT record FROM collie_task_posts
          WHERE task = ${task} AND (${before} IS NULL OR seq < ${before})
          ORDER BY seq DESC LIMIT ${limit}
        `.pipe(
          Effect.map((rows) =>
            Arr.reverse(Arr.flatMap(rows, (row) => Option.toArray(decodePost(row.record)))),
          ),
          Effect.orDie,
        ),
      add: (post) =>
        sql`
          INSERT INTO collie_task_posts (task, seq, id, at, record)
          VALUES (${post.task}, ${post.seq}, ${post.id}, ${post.at}, ${encodePost(post)})
          ON CONFLICT (task, id) DO NOTHING
          RETURNING id
        `.pipe(
          Effect.flatMap((written) => Effect.as(changed, written.length > 0 ? post : null)),
          Effect.orDie,
        ),
    } satisfies ContextApi;
  }),
);

export interface TaskContextNow {
  readonly current: TaskSpec | null;
  readonly revisions: ReadonlyArray<TaskSpec>;
  readonly at: (revision: number) => TaskSpec | null;
}

export const contextOf = (task: string) =>
  TaskContext.use((context) =>
    Effect.map(context.revisions(task), (revisions) => {
      const current = Option.getOrNull(Arr.last(revisions));
      return {
        current,
        revisions,
        at: (revision) =>
          Arr.findFirst(revisions, (one) => one.revision === revision).pipe(Option.getOrNull),
      } satisfies TaskContextNow;
    }),
  );

const digestOf = (text: string, tickets: ReadonlyArray<SpecTicket>) =>
  sha256Hex(Arr.join([text, ...Arr.map(tickets, (ticket) => `${ticket.id}:${ticket.text}`)], "\n"));

export const adoptPlan = Effect.fn("TaskContext.adoptPlan")(function* (input: {
  readonly task: string;
  readonly run: string;
  readonly machine: string | null;
  readonly plan: string;
  readonly actor: string;
  readonly rationale?: string | null | undefined;
  readonly at?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const specPath = path.join(input.plan, "SPEC.md");
  const text = yield* fs.readFileString(specPath).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(Str.trim),
  );
  if (text === "") {
    return { refused: `no plan at ${input.plan}: it has no SPEC.md`, revision: 0 } as const;
  }
  const names = Arr.filter(
    yield* fs.readDirectory(path.join(input.plan, "issues")).pipe(Effect.orElseSucceed(() => [])),
    (name) => Str.endsWith(".md")(name),
  ).sort();
  const copies: Array<{ file: string; text: string }> = [];
  for (const name of names) {
    const body = yield* fs
      .readFileString(path.join(input.plan, "issues", name))
      .pipe(Effect.orElseSucceed(() => ""));
    copies.push({ file: name, text: body });
  }
  const byFile = new Map(Arr.map(copies, (copy) => [copy.file, copy.text] as const));
  const tickets: Array<SpecTicket> = Arr.map(orderedTickets(copies), (slice) => ({
    id: slice.number,
    title: slice.title,
    blockedBy: slice.blockedBy,
    criteria: slice.criteria,
    afterMerge: afterMergeIn(byFile.get(slice.file) ?? ""),
    checks: slice.checks,
    text: Str.trim(byFile.get(slice.file) ?? ""),
  }));
  const context = yield* contextOf(input.task);
  const revision = (context.current?.revision ?? 0) + 1;
  const record: TaskSpec = {
    task: input.task,
    revision,
    at: input.at ?? (yield* nowIso),
    actor: input.actor,
    rationale: input.rationale ?? null,
    text,
    tickets,
    source: {
      kind: "run",
      run: input.run,
      machine: input.machine,
      plan: input.plan,
      planDigest: digestOf(text, tickets),
      from: null,
    },
    digest: digestOf(text, tickets),
  };
  yield* TaskContext.use((context_) => context_.append(record));
  return { revision, spec: record } as const;
});

export interface EditResult {
  readonly applied: boolean;
  readonly current: TaskSpec;
  readonly refused: "stale" | null;
}

export const editSpec = Effect.fn("TaskContext.editSpec")(function* (input: {
  readonly task: string;
  readonly text: string;
  readonly actor: string;
  readonly expected: number;
  readonly rationale?: string | null | undefined;
  readonly at?: string | undefined;
}) {
  const context = yield* contextOf(input.task);
  const base = context.current;
  const current = base?.revision ?? 0;
  if (current !== input.expected) {
    // WARNING: the editor's draft stays theirs; the host answers what to reconcile it against.
    const answered: EditResult = {
      applied: false,
      refused: "stale",
      current: base ?? emptySpec(input.task),
    };
    return answered;
  }
  const parsed = ticketsInSpec(input.text);
  const tickets = parsed.length > 0 ? parsed : (base?.tickets ?? []);
  const record: TaskSpec = {
    task: input.task,
    revision: current + 1,
    at: input.at ?? (yield* nowIso),
    actor: input.actor,
    rationale: input.rationale ?? null,
    text: input.text,
    tickets,
    source: {
      kind: "edit",
      run: null,
      machine: null,
      plan: null,
      planDigest: null,
      from: base?.revision ?? null,
    },
    digest: digestOf(input.text, tickets),
  };
  yield* TaskContext.use((context_) => context_.append(record));
  const answered: EditResult = { applied: true, refused: null, current: record };
  return answered;
});

const emptySpec = (task: string) => {
  const returned: TaskSpec = {
    task,
    revision: 0,
    at: "",
    actor: "",
    rationale: null,
    text: "",
    tickets: [],
    source: null,
    digest: "",
  };
  return returned;
};

const padded = (id: string) => (id.length < 2 ? `0${id}` : id);

const listed = (heading: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [heading, ...Arr.map(lines, (line) => `- ${line}`)];

const requirementsOf = (spec: TaskSpec | null) => (spec === null ? [] : requirementsIn(spec.text));

export const renderBriefing = (input: {
  readonly task: string;
  readonly spec: TaskSpec | null;
  readonly posts: ReadonlyArray<TaskPost>;
  readonly instruction: string | null;
  readonly revision: number;
}) =>
  Arr.join(
    Arr.filter(
      [
        `## The Task you are working on (Task plan revision ${input.revision})`,
        ...listed("Task goal:", [
          objectiveIn(input.spec?.text ?? "") || input.instruction || input.task,
        ]),
        ...listed(
          "Done when:",
          Arr.filterMap([input.spec === null ? null : doneIn(input.spec.text)], (one) =>
            one === null ? Result.failVoid : Result.succeed(one),
          ),
        ),
        ...(input.instruction === null ? [] : [`Original instruction: ${input.instruction}`]),
        ...listed("Requirements:", requirementsOf(input.spec)),
        ...listed(
          "Tickets:",
          Arr.map(
            input.spec?.tickets ?? [],
            (ticket) =>
              `${padded(ticket.id)} ${ticket.title}${ticket.blockedBy.length === 0 ? "" : ` (blocked by ${Arr.join(Arr.map(ticket.blockedBy, padded), ", ")})`}`,
          ),
        ),
        ...listed(
          "Decisions:",
          Arr.map(
            Arr.filter(input.posts, (post) => post.kind === "decision"),
            (post) => `${post.text} (${post.id})`,
          ),
        ),
        ...listed(
          "Challenges:",
          Arr.map(
            Arr.filter(input.posts, (post) => post.kind === "challenge"),
            (post) => `${post.text} (${post.id})`,
          ),
        ),
        ...listed(
          "Activity:",
          Arr.map(
            Arr.filter(input.posts, (post) => post.kind === "comment"),
            (post) => `${post.at} ${post.actor.by}: ${post.text} (${post.id})`,
          ),
        ),
      ],
      (line) => line !== "",
    ),
    "\n",
  );

const unanswered = (posts: ReadonlyArray<TaskPost>) => {
  const answered = new Set(
    Arr.flatMap(posts, (post) => (post.kind === "resolution" ? post.about : [])),
  );
  return Arr.filterMap(posts, (post) =>
    post.kind === "challenge" && !answered.has(post.id) ? Result.succeed(post.id) : Result.failVoid,
  );
};

export const pinRun = Effect.fn("TaskContext.pinRun")(function* (input: {
  readonly task: string;
  readonly run: string;
  readonly at?: string | undefined;
}) {
  const pinned = yield* TaskContext.use((context) => context.pinned(input.run));
  if (pinned !== null) {
    return pinned;
  }
  const context = yield* contextOf(input.task);
  const posts = yield* TaskContext.use((context_) => context_.posts(input.task, 200, null));
  const task = yield* readTask(input.task).pipe(Effect.orElseSucceed(() => null));
  const revision = context.current?.revision ?? 0;
  const pin: TaskPin = {
    run: input.run,
    task: input.task,
    revision,
    at: input.at ?? (yield* nowIso),
    digest: context.current?.digest ?? "",
    briefing: renderBriefing({
      task: input.task,
      spec: context.current,
      posts,
      instruction: task?.instruction ?? null,
      revision,
    }),
  };
  yield* TaskContext.use((context_) => context_.pin(pin));
  return (yield* TaskContext.use((context_) => context_.pinned(input.run))) ?? pin;
});

export const pinOf = (run: string) => TaskContext.use((context) => context.pinned(run));

export const briefingFor = (pin: TaskPin) => pin.briefing;

export const newPostId = Effect.fn("TaskContext.newPostId")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return `post-${Str.slice(0, 8)(yield* random.uuidV4())}`;
});

const actorFor = (by: string, source: TaskPost["source"]) => {
  const returned: Actor = {
    by,
    kind: source === null ? "human" : source.kind === "agent" ? "agent" : "host",
  };
  return returned;
};

export const appendEvent = Effect.fn("TaskContext.appendEvent")(function* (input: {
  readonly task: string;
  readonly id: string;
  readonly kind: TaskPost["kind"];
  readonly text: string;
  readonly source: TaskPost["source"];
  readonly about?: ReadonlyArray<string> | undefined;
}) {
  const last = Option.getOrNull(
    Arr.last(yield* TaskContext.use((context_) => context_.posts(input.task, 1, null))),
  );
  const post: TaskPost = {
    task: input.task,
    seq: (last?.seq ?? 0) + 1,
    id: input.id,
    kind: input.kind,
    at: yield* nowIso,
    actor: actorFor("Collie", input.source),
    text: input.text,
    source: input.source,
    about: [...(input.about ?? [])],
    question: false,
  };
  return yield* TaskContext.use((context_) => context_.add(post));
});

export const postTo = Effect.fn("TaskContext.postTo")(function* (input: {
  readonly task: string;
  readonly by: string;
  readonly kind: "comment" | "decision" | "challenge";
  readonly text: string;
  readonly source?: TaskPost["source"] | undefined;
  readonly about?: ReadonlyArray<string> | undefined;
}) {
  const id = yield* newPostId();
  const last = Option.getOrNull(
    Arr.last(yield* TaskContext.use((context) => context.posts(input.task, 1, null))),
  );
  const post: TaskPost = {
    task: input.task,
    seq: (last?.seq ?? 0) + 1,
    id,
    kind: input.kind,
    at: yield* nowIso,
    actor: actorFor(input.by, input.source ?? null),
    text: input.text,
    source: input.source ?? null,
    about: [...(input.about ?? [])],
    question: input.kind === "challenge",
  };
  const written = yield* TaskContext.use((context) => context.add(post));
  return written === null
    ? ({ state: "already" as const, id } as const)
    : ({ state: "applied" as const, id, post } as const);
});

export const resolvePost = Effect.fn("TaskContext.resolvePost")(function* (input: {
  readonly task: string;
  readonly by: string;
  readonly decision: string;
  readonly challenge: string;
  readonly text: string;
}) {
  const id = yield* newPostId();
  const last = Option.getOrNull(
    Arr.last(yield* TaskContext.use((context) => context.posts(input.task, 1, null))),
  );
  const post: TaskPost = {
    task: input.task,
    seq: (last?.seq ?? 0) + 1,
    id,
    kind: "resolution",
    at: yield* nowIso,
    actor: actorFor(input.by, null),
    text: input.text,
    source: {
      kind: "decision",
      run: null,
      agent: null,
      machine: null,
      revision: null,
      decision: input.decision,
      report: null,
      ref: null,
    },
    about: [input.decision, input.challenge],
    question: false,
  };
  const written = yield* TaskContext.use((context) => context.add(post));
  return written === null
    ? ({ state: "already" as const, id } as const)
    : ({ state: "applied" as const, id, post } as const);
});

export const activityOf = Effect.fn("TaskContext.activityOf")(function* (
  task: string,
  options: { readonly limit?: number | undefined; readonly before?: number | undefined } = {},
) {
  const limit = options.limit ?? 50;
  const posts = yield* TaskContext.use((context) =>
    context.posts(task, limit, options.before ?? null),
  );
  const all = yield* TaskContext.use((context) => context.posts(task, 10_000, null));
  const first = posts[0]?.seq;
  return {
    posts,
    older: first === undefined ? 0 : Arr.length(Arr.filter(all, (post) => post.seq < first)),
    decisions: Arr.filterMap(all, (post) =>
      post.kind === "decision" ? Result.succeed(post.id) : Result.failVoid,
    ),
    unresolved: unanswered(all),
  };
});

export interface TicketEvidenceEntry {
  readonly run: string;
  readonly revision: number;
  readonly head: string;
  readonly answers: ReadonlyArray<Criterion>;
  readonly verifications: ReadonlyArray<Verification>;
}

export const ticketEvidence = (spec: TaskSpec, entries: ReadonlyArray<TicketEvidenceEntry>) => {
  const mine = Arr.filter(entries, (entry) => entry.revision === spec.revision);
  return Arr.map(spec.tickets, (ticket) => ({
    id: ticket.id,
    title: ticket.title,
    afterMerge: ticket.afterMerge,
    criteria: Arr.map(ticket.criteria, (criterion) => {
      const claims = Arr.flatMap(mine, (entry) =>
        Arr.map(
          criteriaEvidence({
            criteria: [criterion],
            answers: entry.answers,
            passing: passingAt(entry.verifications, entry.head),
          }),
          (one) => ({
            ...one,
            run: entry.run,
            proofs: Arr.map(one.proved, (verification) => ({ run: entry.run, verification })),
          }),
        ),
      );
      const claimed =
        Option.getOrNull(Arr.findFirst(claims, (one) => one.claimed !== null))?.claimed ?? null;
      const proofs = Arr.flatten(Arr.map(claims, (one) => one.proofs));
      return {
        criterion,
        claimed,
        proofs,
        // WARNING: a claim nobody proved is shown as unproved, whatever the builder wrote.
        unproved: claimed === null || proofs.length === 0,
      };
    }),
  }));
};

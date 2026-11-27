// WARNING: a Task's record is read from its own revisions and posts, never from a Run's files.
import * as Arr from "effect/Array";
import { Effect, Schema } from "effect";
import { compareSpecs, doneIn, objectiveIn } from "./task-spec";
import type { SpecTicket } from "./task-spec";
import { activityOf, contextOf } from "./task-context";
import type { TaskPost, TaskSpec } from "./task-context";
import { readTask } from "./task";

export const SpecTicketView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  criteria: Schema.Array(Schema.String),
  afterMerge: Schema.Array(Schema.String),
});

export const SpecView = Schema.Struct({
  revision: Schema.Finite,
  at: Schema.String,
  actor: Schema.String,
  rationale: Schema.NullOr(Schema.String),
  objective: Schema.String,
  done: Schema.NullOr(Schema.String),
  text: Schema.String,
  tickets: Schema.Array(SpecTicketView),
  // WARNING: where it came from, so an adopted revision opens its Run's plan as it stood.
  source: Schema.NullOr(
    Schema.Struct({
      kind: Schema.String,
      run: Schema.NullOr(Schema.String),
      machine: Schema.NullOr(Schema.String),
      plan: Schema.NullOr(Schema.String),
      planDigest: Schema.NullOr(Schema.String),
    }),
  ),
});

export const PostView = Schema.Struct({
  seq: Schema.Finite,
  id: Schema.String,
  kind: Schema.String,
  at: Schema.String,
  actor: Schema.Struct({ by: Schema.String, kind: Schema.String }),
  text: Schema.String,
  about: Schema.Array(Schema.String),
  source: Schema.NullOr(
    Schema.Struct({
      kind: Schema.String,
      run: Schema.NullOr(Schema.String),
      agent: Schema.NullOr(Schema.String),
      revision: Schema.NullOr(Schema.Finite),
    }),
  ),
});

export const TaskContextRead = Schema.Struct({
  task: Schema.String,
  label: Schema.String,
  instruction: Schema.NullOr(Schema.String),
  current: Schema.NullOr(SpecView),
  spec: Schema.NullOr(SpecView),
  revisions: Schema.Array(SpecView),
  // WARNING: present only where two revisions were named: the Plan view compares them and no other.
  comparison: Schema.NullOr(
    Schema.Struct({
      from: Schema.Finite,
      to: Schema.Finite,
      rationale: Schema.NullOr(Schema.String),
      sections: Schema.Array(
        Schema.Struct({
          heading: Schema.String,
          added: Schema.Array(Schema.String),
          removed: Schema.Array(Schema.String),
        }),
      ),
      addedTickets: Schema.Array(SpecTicketView),
      removedTickets: Schema.Array(SpecTicketView),
      changedTickets: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          added: Schema.Array(Schema.String),
          removed: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
  activity: Schema.Struct({ posts: Schema.Array(PostView), older: Schema.Finite }),
  decisions: Schema.Array(Schema.String),
  unresolved: Schema.Array(Schema.String),
});
export type TaskContextRead = typeof TaskContextRead.Type;

const view = (spec: TaskSpec) => {
  const returned: Schema.Schema.Type<typeof SpecView> = {
    revision: spec.revision,
    at: spec.at,
    actor: spec.actor,
    rationale: spec.rationale,
    objective: objectiveIn(spec.text),
    done: doneIn(spec.text),
    text: spec.text,
    tickets: Arr.map(spec.tickets, (ticket: SpecTicket) => ({
      id: ticket.id,
      title: ticket.title,
      blockedBy: ticket.blockedBy,
      criteria: ticket.criteria,
      afterMerge: ticket.afterMerge,
    })),
    source:
      spec.source === null
        ? null
        : {
            kind: spec.source.kind,
            run: spec.source.run,
            machine: spec.source.machine,
            plan: spec.source.plan,
            planDigest: spec.source.planDigest,
          },
  };
  return returned;
};

const postView = (post: TaskPost) => {
  const returned: Schema.Schema.Type<typeof PostView> = {
    seq: post.seq,
    id: post.id,
    kind: post.kind,
    at: post.at,
    actor: { by: post.actor.by, kind: post.actor.kind },
    text: post.text,
    about: post.about,
    source:
      post.source === null
        ? null
        : {
            kind: post.source.kind,
            run: post.source.run ?? null,
            agent: post.source.agent ?? null,
            revision: post.source.revision ?? null,
          },
  };
  return returned;
};

export const readTaskContext = Effect.fn("TaskContext.read")(function* (input: {
  readonly task: string;
  readonly revision?: number | undefined;
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
  readonly compare?: { readonly from: number; readonly to: number } | undefined;
}) {
  const task = yield* readTask(input.task).pipe(Effect.orElseSucceed(() => null));
  if (task === null) {
    return null;
  }
  const context = yield* contextOf(input.task);
  const activity = yield* activityOf(input.task, {
    limit: input.limit ?? 50,
    before: input.before,
  });
  const named =
    input.revision === undefined ? context.current : (context.at(input.revision) ?? null);
  const from = input.compare === undefined ? null : (context.at(input.compare.from) ?? null);
  const to = input.compare === undefined ? null : (context.at(input.compare.to) ?? null);
  const compared = from === null || to === null ? null : compareSpecs(from, to);
  return {
    task: task.id,
    label: task.label,
    instruction: task.instruction ?? null,
    current: context.current === null ? null : view(context.current),
    spec: named === null ? null : view(named),
    revisions: Arr.map(context.revisions, view),
    comparison:
      compared === null
        ? null
        : {
            from: compared.from,
            to: compared.to,
            rationale: compared.rationale,
            sections: compared.sections,
            addedTickets: Arr.map(compared.addedTickets, (ticket) => ({
              id: ticket.id,
              title: ticket.title,
              blockedBy: ticket.blockedBy,
              criteria: ticket.criteria,
              afterMerge: ticket.afterMerge,
            })),
            removedTickets: Arr.map(compared.removedTickets, (ticket) => ({
              id: ticket.id,
              title: ticket.title,
              blockedBy: ticket.blockedBy,
              criteria: ticket.criteria,
              afterMerge: ticket.afterMerge,
            })),
            changedTickets: compared.changedTickets,
          },
    activity: { posts: Arr.map(activity.posts, postView), older: activity.older },
    decisions: activity.decisions,
    unresolved: activity.unresolved,
  } satisfies TaskContextRead;
});

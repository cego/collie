// Talking to Collie, and answering it.
//
// `steer` is a question. It never does anything: it writes down what was said, asks the
// evaluator, records what came back as a proposal, and prints it. `confirm` is the
// separate act that makes a specific proposal happen, and it names that proposal and its
// exact contents — a yes to a summary is not consent to a payload nobody read.

import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  carryOutProposal,
  declineProposal,
  err,
  evaluationDeps,
  steer as steerRun,
} from "../operations";
import { RunStore } from "../run";
import { proposalsPath, reconcileStep } from "../proposals";
import {
  deliveriesOf,
  herdOf,
  readLedger,
  reconcile as reconcileDelivery,
  appendLine,
} from "../steering";
import { mutation } from "../envelope";
import { actorName, actorNow, answering, mutating, runIdArg, requestIdFlag } from "./shared";
import { nowIso } from "../time";

export const steer = Command.make(
  "steer",
  {
    text: Argument.string("text").pipe(
      Argument.withDescription("What you want to say, in your own words"),
    ),
    target: Flag.string("target").pipe(
      Flag.withDescription("`run:<id>`; required for anything that would change something"),
      Flag.optional,
    ),
    from: Flag.string("from").pipe(
      Flag.withDescription("The card this is about, so the proposal is bound to its revision"),
      Flag.optional,
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Print what Collie would propose without recording a proposal"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ text, target, from, dryRun, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const named = Option.getOrNull(target);
        const run = named === null ? null : named.replace(/^run:/, "");
        if (named !== null && run === "") return err("invalid_input", "--target is `run:<id>`.");
        return yield* mutation(env, "steer", requestId, (id) =>
          Effect.gen(function* () {
            const deps = yield* evaluationDeps(env);
            return yield* steerRun(env, deps, {
              text,
              target: run,
              from: Option.getOrNull(from),
              dryRun,
              requestId: id,
            });
          }),
        );
      }),
    ),
).pipe(
  Command.withDescription("Say something to Collie about a Run, and get back what it proposes"),
);

const hashFlag = Flag.string("hash").pipe(
  Flag.withDescription("The proposal's content hash, as `steer` printed it"),
);

const proposalIdArg = Argument.string("proposal-id").pipe(
  Argument.withDescription("The proposal, as `steer` printed it"),
);

/**
 * Carry out a confirmed proposal, action by action, in order. Each one is admitted again
 * immediately before it runs and journalled on both sides of running, so a crash leaves a
 * record that says which action nobody can account for. The first failure stops the rest:
 * a sequence the human approved as a sequence is not half-applied on a guess.
 */
export const confirm = Command.make(
  "confirm",
  { proposalId: proposalIdArg, hash: hashFlag, requestId: requestIdFlag },
  ({ proposalId, hash, requestId }) =>
    mutating("confirm", requestId, (env, id) =>
      carryOutProposal(env, proposalId, hash, actorNow(id)),
    ),
).pipe(Command.withDescription("Carry out a proposal, naming it and its exact contents"));

export const decline = Command.make(
  "decline",
  { proposalId: proposalIdArg, requestId: requestIdFlag },
  ({ proposalId, requestId }) =>
    mutating("decline", requestId, (env, id) => declineProposal(env, proposalId, actorNow(id))),
).pipe(Command.withDescription("Say no to a proposal, so it stops being pending"));

/**
 * What has been sent to a Run's agents, and the one thing a human can settle: a delivery
 * nobody can say the fate of. Collie never decides that for itself, which is why this is
 * a command and not a timeout.
 */
export const runDeliveries = Command.make(
  "deliveries",
  {
    runId: runIdArg,
    reconcile: Flag.string("reconcile").pipe(
      Flag.withDescription("A delivery id to settle, for one nobody can account for"),
      Flag.optional,
    ),
    as: Flag.string("as").pipe(
      Flag.withDescription("`sent` or `not-sent`: what actually happened to it"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, reconcile, as, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const store = new RunStore(env.stateDir);
        const run = yield* store.load(runId).pipe(Effect.catch(() => Effect.succeed(null)));
        if (run === null) return err("run_not_found", `No Run "${runId}".`);
        const mine = yield* deliveriesOf(env.stateDir, runId);

        const settleId = Option.getOrNull(reconcile);
        if (settleId === null)
          return {
            ok: true as const,
            data: { deliveries: mine.map((entry) => entry.delivery) },
            human:
              mine
                .map((e) =>
                  [e.delivery.id, e.delivery.state, e.delivery.cause.kind, e.delivery.note ?? ""]
                    .join("\t")
                    .trimEnd(),
                )
                .join("\n") || "Nothing has been sent to this Run's agents.",
          };

        const how = Option.getOrNull(as);
        if (how !== "sent" && how !== "not-sent")
          return err("invalid_input", "--as is `sent` or `not-sent`.");
        const found = mine.find((entry) => entry.delivery.id === settleId);
        if (!found) return err("invalid_input", `No delivery "${settleId}" for this Run.`);
        return yield* mutation(env, "run-deliveries-reconcile", requestId, (id) =>
          Effect.gen(function* () {
            const lines = yield* readLedger(found.file);
            // Derived, never stamped: `reconcile` is human-only, and a request id is
            // not evidence that a person made it — a Driver has one too.
            const settled = reconcileDelivery(
              lines,
              settleId,
              how,
              actorName(actorNow(id)),
              yield* nowIso(),
            );
            if ("error" in settled) return err("invalid_input", settled.error);
            yield* appendLine(found.file, settled);
            return {
              ok: true as const,
              data: { delivery: settled },
              human: `Reconciled ${settleId} as ${how}.`,
            };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("What has been sent to a Run's agents, and settle what is unknown"));

/** A proposal action that started and never settled, answered by the person who knows. */
export const proposal = Command.make("proposal").pipe(
  Command.withDescription("Settle a proposal action nobody can account for"),
  Command.withSubcommands([
    Command.make(
      "reconcile",
      {
        proposalId: proposalIdArg,
        index: Argument.string("index").pipe(
          Argument.withDescription("Which action, by its position in the proposal"),
        ),
        as: Flag.string("as").pipe(
          Flag.withDescription("`applied` or `not-applied`: what actually happened"),
        ),
        requestId: requestIdFlag,
      },
      ({ proposalId, index, as, requestId }) =>
        answering((env) =>
          Effect.gen(function* () {
            const at = Number(index);
            if (!Number.isInteger(at) || at < 0)
              return err("invalid_input", "The index is a whole number.");
            if (as !== "applied" && as !== "not-applied")
              return err("invalid_input", "--as is `applied` or `not-applied`.");
            return yield* mutation(env, "proposal-reconcile", requestId, (id) =>
              Effect.gen(function* () {
                const file = yield* proposalsPath(env.stateDir, yield* herdOf(env.socketPath));
                const done = yield* reconcileStep(file, proposalId, at, as, actorNow(id));
                return done.refused === null
                  ? {
                      ok: true as const,
                      data: { proposal: proposalId, index: at, as },
                      human: `Settled action ${at} as ${as}.`,
                    }
                  : err("invalid_input", done.detail, { reason: done.refused });
              }),
            );
          }),
        ),
    ),
  ]),
);

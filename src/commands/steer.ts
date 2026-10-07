// Saying something to Collie about one Run, and answering what it proposes.
//
// `steer` carries out requested actions. `--dry-run` previews them instead; `confirm`
// remains available for optional proposals already on the board.
//
// It is about a Run, always. Questions about the flock are the Home's native chat, which
// reads through `collie tools` rather than paying for a model to be asked one here.

import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { err } from "../operations";
import {
  confirmProposed,
  declineProposed,
  reconcileDelivered,
  reconcileProposed,
  steerAbout,
} from "../lifecycle";
import { findRun } from "../runs";
import { journalOf, read as readProposals, type ProposalRecord } from "../proposals";
import { deliveriesOf } from "../steering";
import { mutation } from "../envelope";
import { answering, cliDoor, mutating, runIdArg, requestIdFlag } from "./shared";

export const steer = Command.make(
  "steer",
  {
    text: Argument.String("text").pipe(
      Argument.withDescription("What you want to say, in your own words"),
    ),
    target: Flag.String("target").pipe(Flag.withDescription("`run:<id>`: which Run this is about")),
    from: Flag.String("from").pipe(
      Flag.withDescription("The card this is about, so the proposal is bound to its revision"),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print what Collie would propose without recording a proposal"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ text, target, from, dryRun, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const run = target.replace(/^run:/, "");
        if (run === "") return err("invalid_input", "--target is `run:<id>`.");
        return yield* mutation(env, "steer", requestId, (id) =>
          Effect.flatMap(cliDoor(env), (door) =>
            steerAbout(env, {
              door,
              runId: run,
              text,
              from: Option.getOrNull(from),
              dryRun,
              request: id,
            }),
          ),
        );
      }),
    ),
).pipe(Command.withDescription("Ask Collie to act on a Run; --dry-run previews without acting"));

const hashFlag = Flag.String("hash").pipe(
  Flag.withDescription("Optionally require this exact proposal content hash"),
  Flag.optional,
);

const proposalIdArg = Argument.String("proposal-id").pipe(
  Argument.withDescription("The proposal, as `steer` printed it"),
);

/** The proposal's own hash, for a yes that names only its id: the host still checks one. */
const hashOf = Effect.fn("Steer.hashOf")(function* (stateDir: string, id: string) {
  const file = yield* journalOf(stateDir, id);
  const found = file === null ? [] : yield* readProposals(file);
  return (
    found.find((line): line is ProposalRecord => line.kind === "proposal" && line.id === id)
      ?.content_hash ?? ""
  );
});

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
      Effect.gen(function* () {
        return yield* confirmProposed(env, {
          door: yield* cliDoor(env),
          proposal: proposalId,
          hash: Option.isSome(hash) ? hash.value : yield* hashOf(env.stateDir, proposalId),
          request: id,
        });
      }),
    ),
).pipe(Command.withDescription("Carry out a proposal, naming it and its exact contents"));

export const decline = Command.make(
  "decline",
  { proposalId: proposalIdArg, hash: hashFlag, requestId: requestIdFlag },
  ({ proposalId, hash, requestId }) =>
    mutating("decline", requestId, (env, id) =>
      Effect.gen(function* () {
        return yield* declineProposed(env, {
          door: yield* cliDoor(env),
          proposal: proposalId,
          hash: Option.isSome(hash) ? hash.value : yield* hashOf(env.stateDir, proposalId),
          request: id,
        });
      }),
    ),
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
    reconcile: Flag.String("reconcile").pipe(
      Flag.withDescription("A delivery id to settle, for one nobody can account for"),
      Flag.optional,
    ),
    as: Flag.String("as").pipe(
      Flag.withDescription("`sent` or `not-sent`: what actually happened to it"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, reconcile, as, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        if ((yield* findRun(env, runId)) === null)
          return err("run_not_found", `No Run "${runId}".`);
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
        if (!mine.some((entry) => entry.delivery.id === settleId))
          return err("invalid_input", `No delivery "${settleId}" for this Run.`);
        const door = yield* cliDoor(env);
        return yield* mutation(env, "run-deliveries-reconcile", requestId, (id) =>
          reconcileDelivered(env, { door, runId, delivery: settleId, as: how, request: id }),
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
        index: Argument.String("index").pipe(
          Argument.withDescription("Which action, by its position in the proposal"),
        ),
        as: Flag.String("as").pipe(
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
            const door = yield* cliDoor(env);
            return yield* mutation(env, "proposal-reconcile", requestId, (id) =>
              reconcileProposed(env, { door, proposal: proposalId, index: at, as, request: id }),
            );
          }),
        ),
    ),
  ]),
);

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, Option, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { err } from "../operations";
import { refusal, verifyRun } from "../lifecycle";
import { FrontDoor, HostRefused } from "../board-model";
import type { Echo } from "../verify";
import { movedLine, type Verification } from "../verify-model";
import { checkNameOf } from "../verify-spec";
import { NAMED_FAILURES, failureReader } from "../bun-tests";
import { printResult } from "../envelope";
import { answering, cliDoor, root } from "./shared";

// WARNING: under --json both streams go to stderr, since stdout is the one envelope.
const echoed = Effect.fn("collie.verify.echoed")(function* () {
  const stdio = yield* Stdio.Stdio;
  const json = (yield* root).json;
  const to = (stream: "stdout" | "stderr") => (text: string) =>
    Stream.make(text).pipe(Stream.run(stdio[stream]({ endOnDone: false })), Effect.ignore);
  const returned: Echo = {
    stdout: to(json ? "stderr" : "stdout"),
    stderr: to("stderr"),
  };
  return returned;
});

const logRef = (record: Verification) => {
  const under = `/evidence/${record.run}/`;
  const log = record.log ?? "";
  return Option.match(pipe(log, Str.indexOf(under)), {
    onNone: () => `verification:${record.id}`,
    onSome: (at) => `evidence:${pipe(log, Str.slice(at + under.length))}`,
  });
};

const unstableWhy = (record: Verification) =>
  (record.start.unmeasured ?? record.end.unmeasured)
    ? `the tree could not be measured: ${record.start.unmeasured ?? record.end.unmeasured}`
    : `the tree moved while it ran, from ${record.start.fingerprint} to ${record.end.fingerprint}`;

const bounded = (record: Verification, ran: boolean, failures: ReadonlyArray<string>) => {
  const log = logRef(record);
  const failed = failures.slice(0, NAMED_FAILURES);
  const more = failures.length - failed.length;
  const read = `The output was bounded to its last 4 KB per stream; read the rest with collie run read ${record.run} ${log} --start <line> --count <lines>, or --search <pattern>.`;
  const tails = Arr.filter(
    [
      ["stdout", record.tail.stdout],
      ["stderr", record.tail.stderr],
    ] as const,
    ([, text]) => text !== "",
  );
  return {
    ok: true as const,
    data: { verification: record, ran, failed, more, log, bounded: read },
    human: Arr.join(
      [
        `${record.name}: ${record.result} (exit ${record.exit})${ran ? "" : `, not run again: verification ${record.id} on this tree`}`,
        ...(record.result === "unstable" ? [`unstable: ${unstableWhy(record)}`] : []),
        ...(failures.length === 0
          ? []
          : [
              `Failed tests (${failures.length}):`,
              ...Arr.map(failed, (name) => `  ${name}`),
              ...(more > 0 ? [`  and ${more} more`] : []),
            ]),
        ...Arr.flatMap(tails, ([stream, text]) => [`Last of ${stream}:`, text]),
        read,
      ],
      "\n",
    ),
  };
};

// WARNING: not a mutation: a replayed request id would hand back a result about a tree that has since moved.
export const verify = Command.make(
  "verify",
  {
    runId: Flag.String("run").pipe(
      Flag.withDescription(
        "The Run this is a verification of; its tree is what is fingerprinted. By default the Run whose agent this pane is",
      ),
      Flag.optional,
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Where to run it; must be inside that Run's own checkout"),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription(
        "What to call it on a card; by default the script it runs, else the tool and its subcommand, else the tool",
      ),
      Flag.optional,
    ),
    expect: Flag.String("expect").pipe(
      Flag.withDescription(
        "What a pass looks like: `pass` (default), or `fail` for a reproduction that must fail",
      ),
      Flag.optional,
    ),
    again: Flag.Boolean("again").pipe(
      Flag.withDescription(
        "Run it even where this tree already has a record of it, to look for a flake; never runs one of the Run's Checks",
      ),
      Flag.withDefault(false),
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The executable and its arguments, after `--`"),
      Argument.variadic({ min: 1 }),
    ),
  },
  ({ runId, cwd, name, expect, again, command }) => {
    const [executable, ...argv] = command;
    if (executable === undefined)
      return printResult(err("invalid_input", "verify needs a command to run."), true);
    const wanted = Option.getOrElse(expect, () => "pass");
    if (wanted !== "pass" && wanted !== "fail")
      return printResult(
        err("invalid_input", `--expect is "pass" or "fail", not "${wanted}".`),
        true,
      );
    return answering((env) =>
      Effect.scoped(
        Effect.gen(function* () {
          const door = yield* cliDoor(env);
          const run = Option.getOrElse(runId, () =>
            Schema.is(FrontDoor)(door) ? null : door.from.run,
          );
          if (run === null)
            return err("invalid_input", "verify needs --run outside a Run's agent pane.");
          const request = {
            runId: run,
            name: Option.getOrElse(name, () => checkNameOf(executable, argv)),
            executable,
            argv,
            expect: wanted,
            again,
          } satisfies Parameters<typeof verifyRun>[1];
          const where = Option.getOrUndefined(cwd);
          const opened = yield* verifyRun(
            env,
            where === undefined ? request : { ...request, cwd: where },
            door,
          );
          if (!opened.ok) return opened;
          const byAgent = !Schema.is(FrontDoor)(door);
          const readers = { stdout: failureReader(), stderr: failureReader() };
          const shown = yield* echoed();
          const bounding: Echo = {
            stdout: (text) => Effect.sync(() => readers.stdout.feed(text)),
            stderr: (text) => Effect.sync(() => readers.stderr.feed(text)),
          };
          let started = false;
          type Answered = { verification: Verification; ran: boolean };
          const nothingYet: () => Answered | null = () => null;
          const answered = yield* Stream.runFoldEffect(opened.events, nothingYet, (last, event) =>
            event._tag === "Output"
              ? (byAgent && started ? bounding : shown)
                  [event.stream](event.text)
                  .pipe(Effect.as(last))
              : event._tag === "Started"
                ? Effect.sync(() => {
                    started = true;
                    return last;
                  })
                : Effect.succeed({ verification: event.verification, ran: event.ran ?? true }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(HostRefused)(cause)
                  ? refusal(cause)
                  : err("operation_failed", String(cause)),
              ),
            ),
          );
          if (answered === null)
            return err("operation_failed", "The verification ended without a record.");
          if ("ok" in answered) return answered;
          const { verification: record, ran } = answered;
          process.exitCode = record.exit;
          if (byAgent)
            return bounded(
              record,
              ran,
              ran
                ? [...readers.stdout.names(), ...readers.stderr.names()]
                : Arr.map(record.failed ?? [], (one) => `${one.file} > ${one.name}`),
            );
          return {
            ok: true as const,
            data: { verification: record, ran },
            human: ran
              ? `${record.name}: ${record.result} (exit ${record.exit})${movedLine(record) === "" ? "" : `; moved under it: ${movedLine(record)}`}`
              : `${record.name}: ${record.result} (exit ${record.exit}), not run again: verification ${record.id} on this tree${record.log === undefined ? "" : `; its log is ${record.log}`}`,
          };
        }),
      ),
    );
  },
).pipe(
  Command.withDescription("Run a command and record its result against this Run's tree"),
  Command.withExamples([
    {
      command: "collie verify -- bun test",
      description: "From a Run's agent pane: record a test run against that Run's own checkout",
    },
    {
      command: "collie --json verify --run implement-picker-20260909-101112 -- bun test",
      description: "Anywhere else: name the Run",
    },
    {
      command: "collie verify --name typecheck -- bun run typecheck",
      description: "Name it, so a card can say which verification passed",
    },
    {
      command: "collie verify --name regression --expect fail -- bun test test/bug.test.ts",
      description: "Prove a bug exists: the record passes because the command failed",
    },
    {
      command: "collie verify --again -- bun test test/flaky.test.ts",
      description: "Run it again although this tree has a record of it, for a suspected flake",
    },
  ]),
);

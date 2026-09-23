// A Run from both front doors: start it, watch it, and pick it up again.
//
// The CLI and the picker do the same things to a workflow saved as a module, so they do
// them here rather than each their own way: which id is a module's, the claim that makes a
// retry one Run, and the read model show, list and wait are drawn from. Execution belongs
// to the host — this is the client side of it, and it holds no state of its own.
//
// What a Run is and what became of it stays Collie's; what a workflow has done stays
// Effect's. Nothing here copies the second into the first.

import { Effect, FileSystem, Schema, Stream } from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { PluginEnv } from "./env";
import { savedModules, type Fault, type Found } from "./discovery";
import type { Kept } from "./history";
import { connect, type HostClient, type HostUnavailable, type HostVersionMismatch } from "./host";
import {
  REFUSED_INPUT,
  type Given,
  type HostRefused,
  type OfferView,
  type RunView,
} from "./engine";
import { err, taskFor, type Failure, type OpResult } from "./operations";
import type { TaskChoice } from "./task";
import type { HistoryRow, RequestConflict } from "./store";
import { renderApproved, type VerifySpec } from "./verify-spec";

export { savedModules } from "./discovery";

/**
 * The inputs this module needs that nobody gave it, as the refusal an agent can fill in
 * and retry with the same request id. Each carries what it will take, so a caller that
 * has never seen the module can still answer it.
 */
export const neededInputs = (entry: Found, given: Given): Failure | null => {
  const missing = entry.inputs.filter(
    (field) =>
      field.required &&
      given.text[field.name] === undefined &&
      given.json[field.name] === undefined,
  );
  if (missing.length === 0) return null;
  return err(
    "needs_input",
    `${entry.id} needs ${missing.map((field) => `"${field.name}"`).join(", ")}.`,
    {
      workflow: entry.id,
      // The file this is about, so a caller told to fill something in can read what it
      // is filling in for — the same path `workflow show` and the definitions tool name.
      path: entry.path,
      inputs: missing.map((field) => ({
        name: field.name,
        question: `${entry.title} — ${field.name}?`,
        schema: field.schema,
        limits: [...field.limits],
      })),
    },
  );
};

/**
 * The saved module this id names: the entry where one loads, the fault where the file
 * will not, and null where no module claims it. A broken module is a file to fix rather
 * than nothing.
 */
export const moduleFor = (
  env: PluginEnv,
  id: string,
): Effect.Effect<Found | Fault | null, never, FileSystem.FileSystem> =>
  savedModules(env).pipe(
    Effect.map(
      (found) =>
        found.entries.find((entry) => entry.id === id) ??
        found.problems.find((problem) => problem.id === id) ??
        null,
    ),
  );

/**
 * Whether anything has ever run in this state directory. A machine that has never
 * started a module does not start a host to be told it has none.
 */
/**
 * Whether this installation has any Runs the host is holding. The database is the whole
 * of it: no rows, no host worth starting, and a caller that asked is told so rather than
 * waiting on one that has nothing to say.
 */
export const anyRuns = (env: PluginEnv): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${env.stateDir}/host.db`)),
    Effect.orElseSucceed(() => false),
  );

type HostFailure =
  | HostRefused
  | RequestConflict
  | HostUnavailable
  | HostVersionMismatch
  | RpcClientError.RpcClientError;

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/** A refusal as the front doors say one, with the host's own sentence inside it. */
const refusal = (cause: HostFailure): Failure => {
  switch (cause._tag) {
    case "HostRefused":
      // The host says so first where the input is why, and that is exit 2, not exit 1.
      return cause.reason.startsWith(`${REFUSED_INPUT}:`)
        ? err("invalid_input", cause.reason.slice(REFUSED_INPUT.length + 1).trim())
        : err("operation_failed", cause.reason);
    case "RequestConflict":
      return err("invalid_input", cause.reason, { request: cause.request });
    case "HostVersionMismatch":
      return err("operation_failed", cause.restart, { host: cause.host, pid: cause.pid });
    case "HostUnavailable":
      return err("operation_failed", `No workflow host for ${cause.dir}: ${cause.reason}.`);
    default:
      return err("operation_failed", `The workflow host did not answer: ${String(cause)}.`);
  }
};

/** One question to the host that owns this state directory, asked on its own connection. */
const asks = <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
): Effect.Effect<{ readonly ok: true; readonly value: A } | Failure, never, Client> =>
  Effect.scoped(
    connect(env.stateDir).pipe(
      Effect.flatMap(question),
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
    ),
  );

/** What a start became, or why there is no Run. */
export type RunStart =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly registration: string;
      /** False where the request had already been admitted: a retry, not a second Run. */
      readonly fresh: boolean;
    }
  | Failure;

/**
 * Starts the module this id names, under the caller's own claim on the work. The same
 * request twice is the same Run — which is what makes a retried command, a re-clicked
 * row and a replayed receipt one piece of work rather than three.
 *
 * The Task is chosen first, so the Run's agents open in its workspace rather than in
 * whichever one the host happened to be started from. A fresh one is only named here:
 * the host opens it once it knows the checkout it is rooted at.
 */
export const startRun = Effect.fn("Lifecycle.startRun")(function* (
  env: PluginEnv,
  options: {
    readonly id: string;
    readonly request: string;
    /** What the caller said, in the two halves the author's schemas settle differently. */
    readonly input: Given;
    /** The host's own launch options, kept out of the author's payload. */
    readonly options?: Readonly<Record<string, string>>;
    readonly task: TaskChoice;
    readonly parent?: string | null;
  },
) {
  const placed = yield* taskFor(env, options.task, {
    workflow: options.id,
    named: Object.values(options.input.text)[0] ?? "",
  });
  if (placed._tag === "Rejected") return placed.result;
  return yield* asks(env, (client) =>
    client.start({
      project: env.cwd,
      id: options.id,
      request: options.request,
      input: options.input.json,
      text: options.input.text,
      options: options.options,
      task: placed.task?.id,
      taskLabel: placed.label ?? undefined,
      parent: options.parent ?? undefined,
    }),
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            runId: answered.value.runId,
            registration: answered.value.registration,
            fresh: answered.value.fresh,
          }
        : answered,
    ),
  );
});

/** Every Run a listing can show, and why the rest could not be read. */
export interface RunListing {
  readonly runs: ReadonlyArray<RunView>;
  readonly unreadable: string | null;
}

/** One Run as a front door shows it, or null where the host has none by that id. */
export const runView = (
  env: PluginEnv,
  runId: string,
): Effect.Effect<RunView | Failure | null, never, Client> =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any
        ? asks(env, (client) => client.run({ runId })).pipe(
            Effect.map((answered) => (answered.ok ? answered.value : answered)),
          )
        : Effect.succeed(null),
    ),
  );

/**
 * The checkout a Run's verifications are about: the one the host placed it on. A
 * verification collected anywhere else would bind a real result to a tree nobody is
 * looking at.
 */
export const treeOf = (view: RunView): string => view.cwd;

/**
 * Every Run this state directory has rows for, and why they could not be read
 * where they could not be: a host that will not start costs the caller those Runs,
 * never the listing it asked for.
 */
export const runViews = (
  env: PluginEnv,
  task: string | null,
): Effect.Effect<RunListing, never, Client> =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any
        ? asks(env, (client) => client.runs({ task })).pipe(
            Effect.map((answered) =>
              answered.ok
                ? { runs: answered.value, unreadable: null }
                : { runs: [], unreadable: answered.error.message },
            ),
          )
        : Effect.succeed({ runs: [], unreadable: null }),
    ),
  );

/** What the old engine recorded, as a front door lists it beside the Runs a host owns. */
export interface Historical {
  readonly rows: ReadonlyArray<HistoryRow>;
  readonly unreadable: string | null;
}

/**
 * The Runs the old engine left behind, imported once by whichever host started first.
 * They are readable and nothing more: a row here cannot be answered, controlled or
 * resumed, and `historyRefusal` is what every door says to a caller that tries.
 */
export const historyRows = (
  env: PluginEnv,
  task: string | null,
): Effect.Effect<Historical, never, Client> =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any
        ? asks(env, (client) => client.history({ task })).pipe(
            Effect.map((answered) =>
              answered.ok
                ? { rows: answered.value, unreadable: null }
                : { rows: [], unreadable: answered.error.message },
            ),
          )
        : Effect.succeed({ rows: [], unreadable: null }),
    ),
  );

/**
 * The one pass over what an older Collie left, asked for rather than waited on. The host
 * does the same thing when it starts, and both are idempotent, so this is only ever a way
 * to see what was found.
 */
export const importHistory = (
  env: PluginEnv,
): Effect.Effect<ReadonlyArray<Kept> | Failure, never, Client> =>
  asks(env, (client) => client.import()).pipe(
    Effect.map((answered) => (answered.ok ? answered.value : answered)),
  );

/**
 * What this id is, for a door that could not find a Run for it. Imported work is named
 * as what it is rather than reported missing: the record is right there, and what the
 * caller needs to hear is that it belongs to an engine that is gone and what to do now.
 */
export const historyRefusal = (
  env: PluginEnv,
  runId: string,
  wanted: string,
): Effect.Effect<Failure | null, never, Client> =>
  historyRows(env, null).pipe(
    Effect.map(({ rows }) => {
      const row = rows.find((item) => item.run === runId);
      if (row === undefined) return null;
      return err(
        "operation_failed",
        `${runId} was recorded by the engine Collie no longer has, so it cannot be ${wanted}. ` +
          `Its record and everything it produced are still here; \`collie run start ${row.workflow}\` begins new work.`,
        { run: runId, workflow: row.workflow, history: true },
      );
    }),
  );

/**
 * Every state this Run reaches, until `each` says the caller has what it came for. The
 * first one is where the work is now rather than what changed, so a client that has been
 * away — a board that was closed, a wait that was interrupted — reads the truth instead
 * of waiting for an update that has already been and gone.
 */
export const watchRun = <R>(
  env: PluginEnv,
  runId: string,
  each: (view: RunView) => Effect.Effect<boolean, never, R>,
): Effect.Effect<Failure | null, never, R | Client | Scope.Scope> =>
  Effect.gen(function* () {
    const opened = yield* connect(env.stateDir).pipe(Effect.result);
    if (opened._tag === "Failure") return refusal(opened.failure);
    let known = false;
    return yield* Stream.runForEachWhile(opened.success.watch({ runId }), (view) => {
      // Nothing was admitted under that id, so there is nothing to wait for.
      if (view === null) return Effect.succeed(false);
      known = true;
      return each(view).pipe(Effect.map((enough) => !enough));
    }).pipe(
      Effect.map(() =>
        known ? null : err("run_not_found", `Run "${runId}" was not found.`, { run: runId }),
      ),
      Effect.catchTag("RpcClientError", (cause) => Effect.succeed(refusal(cause))),
    );
  });

/**
 * Registers what the modules as they are now allow and hands over what is outstanding,
 * then says where this Run is. A file that was missing and has been put back is picked up
 * by this rather than by restarting the host.
 */
export const recoverRun = (env: PluginEnv, runId: string): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) => client.recover().pipe(Effect.andThen(client.run({ runId })))).pipe(
    Effect.map((answered) => {
      if (!answered.ok) return answered;
      const view = answered.value;
      if (view === null)
        return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
      return {
        ok: true as const,
        data: { run: view },
        human: describeRun(view).join("\n"),
      };
    }),
  );

/**
 * Settles the question a Run is waiting on. The decision is named where the caller
 * knows which one, and null where it means "the one it is waiting on" — the host refuses
 * that where it is not exactly one, rather than choosing for anybody.
 */
export const answerRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly decision: string | null;
    readonly value: string;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) =>
    client.answer({
      runId: options.runId,
      decision: options.decision,
      value: options.value,
      request: options.request,
    }),
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: options.runId, ...answered.value },
            human: answered.value.fresh
              ? `Answered ${options.runId}: ${answered.value.decision} = ${answered.value.value}.`
              : `${options.runId} already had that answer to ${answered.value.decision}.`,
          }
        : answered,
    ),
  );

/**
 * Sets or clears one control over one Run. A control the host recorded but could
 * not apply says so: work no host is running is held in intent, and calling that done
 * would be a confirmation nobody can stand behind.
 */
export const controlRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly control: "hold" | "stop";
    readonly set: boolean;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) => client.control(options)).pipe(
    Effect.map((answered) => {
      if (!answered.ok) return answered;
      const done = answered.value;
      const what = `${done.set ? done.control : `un${done.control}`} ${done.runId}`;
      if (done.left.length > 0) {
        return err("operation_failed", `Recorded ${what}, but ${done.left.join("; ")}.`, {
          run: done.runId,
          left: [...done.left],
        });
      }
      return {
        ok: true as const,
        data: { run: done.runId, ...done },
        human: done.applied
          ? `${capitalised(what)}.`
          : `Recorded ${what}, but nothing here is running it: ${done.detail}`,
      };
    }),
  );

/** Picks a Run up again from any door: recovered first, then its stop cleared, so what wakes can run. */
export const resumeRun = (env: PluginEnv, runId: string): Effect.Effect<OpResult, never, Client> =>
  recoverRun(env, runId).pipe(
    Effect.tap((recovered) =>
      recovered.ok ? controlRun(env, { runId, control: "stop", set: false }) : Effect.void,
    ),
  );

/** Grants a Run one command Collie may run itself, or withdraws it, through the host. */
export const grantRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly name: string;
    readonly command: Omit<VerifySpec, "name"> | null;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) => client.grant(options)).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: options.runId, approved: answered.value },
            human: [`${options.runId} may have Collie run:`, renderApproved(answered.value)].join(
              "\n",
            ),
          }
        : answered,
    ),
  );

/** Says something of a human's to the agent a Run has, through the host. */
export const steerRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly operation?: string;
    readonly mode?: "boundary" | "now" | "interrupt";
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) => client.steer(options)).pipe(
    Effect.map((answered) => {
      if (!answered.ok) return answered;
      const sent = answered.value;
      // Not delivered is not a failure of the command: it is what is known about the
      // delivery, and the caller is told rather than left to assume it landed.
      return {
        ok: true as const,
        data: { run: options.runId, ...sent },
        human: sent.delivered
          ? `Told ${sent.agent}.`
          : `Nothing was delivered: ${sent.detail || "no agent to tell"}.`,
      };
    }),
  );

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A Run as a human reads one: what it is, where its module is, and what is wrong. */
export const describeRun = (view: RunView): ReadonlyArray<string> => [
  `${view.runId}\t${statusOf(view)}\t${view.workflow}`,
  view.entry,
  `proves ${view.outcome}`,
  ...(view.parent === null ? [] : [`part of ${view.parent}`]),
  ...(view.controls.length === 0 ? [] : [`under ${view.controls.join(", ")}`]),
  ...describeWaiting(view),
  ...(view.diagnostic === null ? [] : [view.diagnostic]),
  ...(view.parked === null ? [] : [view.parked]),
];

/** The questions a Run is still waiting on, with what each will take. */
export const describeWaiting = (view: RunView): ReadonlyArray<string> =>
  view.waiting
    .filter((one) => one.answer === null)
    .map(
      (one) =>
        `waiting on "${one.name}": ${one.prompt}${one.options.length === 0 ? "" : ` (${one.options.join(" | ")})`}`,
    );

/** The one word a listing gives a Run, and the sentence behind it where there is one. */
export const statusOf = (view: RunView): string => {
  switch (view.status.status) {
    case "complete":
      return `complete: ${resultText(view.status.value)}`;
    case "failed":
      return `failed: ${view.status.reason}`;
    default:
      return view.diagnostic === null ? view.status.status : "waiting for its module";
  }
};

const asJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** A result as a line of text: a string as it is, anything else as its JSON. */
export const resultText = (value: Schema.Json): string =>
  isText(value) ? value : asJsonText(value);

const isText = Schema.is(Schema.String);

/** Whether the engine can still change this Run's state. */
export const isSettled = (view: RunView): boolean =>
  view.status.status === "complete" || view.status.status === "failed";

/**
 * What a Run offers to do next. The host answers, because only it holds the module
 * that declared them: an offer is the author's own eligibility asked of the facts as they
 * are now, and a Run whose module has gone is readable with its offers refused by name.
 */
export const showOffers = (env: PluginEnv, runId: string): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: runId, offers: answered.value.map((offer) => ({ ...offer })) },
            human:
              answered.value.length === 0 ? "Nothing is offered." : describeOffers(answered.value),
          }
        : answered,
    ),
  );

/** The offers themselves, for a caller that has to choose one rather than print them. */
export const offersOf = (
  env: PluginEnv,
  runId: string,
): Effect.Effect<ReadonlyArray<OfferView> | Failure, never, Client> =>
  asks(env, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) => (answered.ok ? answered.value : answered)),
  );

const describeOffers = (offers: ReadonlyArray<OfferView>): string =>
  offers
    .map((offer) => {
      const why = offer.unavailable === null ? "" : ` — unavailable: ${offer.unavailable}`;
      return `${offer.primary ? "▸" : " "} ${offer.id}  ${offer.title} (${offer.workflow})${why}`;
    })
    .join("\n");

/** Carries out one of them, under the caller's own claim so a retry is one Run. */
export const invokeOffer = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly offer: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(env, (client) =>
    client.invoke({
      runId: options.runId,
      offer: options.offer,
      input: options.input,
      request: options.request,
    }),
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: answered.value.runId, from: options.runId, offer: options.offer },
            human: `Started run ${answered.value.runId} from ${options.runId}'s "${options.offer}".`,
          }
        : answered,
    ),
  );

// Desktop's channels to a Machine's host: bridge commands started as `desktop` and as
// `chat`, whose output after the ready marker is the host's socket. Never Collie's own host
// client: over a channel that would start a host on this computer, or signal a pid that is
// not its own.

import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Semaphore,
  Schema,
  SchemaIssue,
  Scope,
  Stream,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { BunCrypto } from "@effect/platform-bun";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  BRIDGE_READY,
  type BoardMessage,
  type CleanupReport,
  type BoardSnapshot,
  PROTOCOL,
  FrontDoorRpcs,
  HostRefused,
  leftSaid,
  type ProposalRefused,
  type RequestConflict,
  type RunDetail,
} from "../../../src/board-model";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  HerdrMachines,
  type HerdrMachine,
  type PeerView,
  PeerView as PeerSchema,
} from "../../../src/peers-model";
import { MUX_BOUND, muxArgv, quoted, remoteCollie, riderArgv } from "../../../src/ssh-argv";
import {
  ActionFailed,
  type Credential,
  type DesktopAction,
  type FlockItem,
  type KnownMachine,
  type Machine,
  type MachineMerged,
  type MachineMessage,
  type NotLive,
} from "../shared/flock";
import { CREDENTIAL_SAID, type Lag } from "../shared/in-sync";
import { type MachineUsage, UPGRADE_SAID } from "../shared/usage";
import { type MachineSchedules, SCHEDULES_UPGRADE_SAID } from "../shared/schedules";
import { CLEANUP_UPGRADE_SAID, type CleanupListing } from "../shared/machine-cleanup";
import type { ScheduleChange } from "../../../src/schedule-model";
import type { ActionSchema } from "../../../src/actions";
import type { Mutable } from "effect/Types";
import { moveSchedule, type ScheduleDoor } from "../../../src/schedule-move";
import { CHILD_CWD, childEnv } from "./login-env";
import { backoff } from "../shared/retrying";
import { addressOf } from "../shared/record-terminal";
import { withNotice } from "../../../src/redact";
import {
  type ActionsLog,
  type Attempted,
  confirmed,
  reasonOf,
  type Unconfirmed,
  unlogged,
  withheldOf,
} from "./sent";

const children = new Set<Bun.Subprocess>();
export const endChildren = () => {
  for (const child of children) child.kill();
};

export const spawned = <C extends Bun.Subprocess>(start: () => C) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = start();
      children.add(child);
      return child;
    }),
    (child) =>
      Effect.sync(() => {
        children.delete(child);
        child.kill();
      }),
  );

/** The front doors Desktop opens a Machine's channels as. */
export type Bridged = "desktop" | "chat";

/** The bridge `collie` runs for Desktop, which records Desktop's computer with what it does. */
export const bridgeCommand = (
  collie: ReadonlyArray<string>,
  client: string,
  as: Bridged = "desktop",
) => [...collie, "bridge", "--as", as, "--client", client];

/**
 * The last of what a process has said on a stream so far, each chunk passed on as it comes
 * with what had been said by then.
 */
export const stderrTail = Effect.fnUntraced(function* (
  from: ReadableStream<Uint8Array>,
  echo: (chunk: Uint8Array, said: string) => Effect.Effect<void> = () => Effect.void,
) {
  let text = "";
  const decoder = new TextDecoder();
  yield* Stream.fromReadableStream({ evaluate: () => from, onError: () => undefined }).pipe(
    Stream.runForEach((chunk: Uint8Array) =>
      Effect.suspend(() => {
        text = (text + decoder.decode(chunk, { stream: true })).slice(-4000);
        return echo(chunk, text.trim());
      }),
    ),
    Effect.ignore,
    // Ends with its process.
    Effect.forkDetach,
  );
  return () => text.trim();
});

/** Told what an SSO login a connection waits on asks for. */
export type WaitingOnSso = (said: string) => Effect.Effect<void>;

/** What an SSO login that ssh is waiting on prints before it, as vm-mk's sshd does. */
const SSO = /\bSSO\b/;

/**
 * Why a route shows no live board, short of waiting on SSO, which it reports as it waits;
 * or that it is to be opened again at once, as after its Machine is upgraded.
 */
export interface RouteFailure {
  readonly state: Exclude<NotLive, "sso"> | "reopen";
  readonly reason: string;
}

const unreachable = (reason: string): RouteFailure => ({ state: "unreachable", reason });

/** The shell's own status for a command it could not find. */
const NOT_FOUND = 127;

/** Everything after the ready marker, whatever a login shell printed before it. */
const afterReady = (from: ReadableStream<Uint8Array>, onReady: () => void) => {
  const marker = new TextEncoder().encode(`${BRIDGE_READY}\n`);
  let seen = Buffer.alloc(0);
  let ready = false;
  return from.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, out) => {
        if (ready) return out.enqueue(chunk);
        // Searched as bytes, so a character split across chunks reaches the host whole.
        seen = Buffer.concat([seen, chunk]);
        const at = seen.indexOf(marker);
        if (at === -1) return;
        ready = true;
        onReady();
        const rest = seen.subarray(at + marker.length);
        if (rest.length > 0) out.enqueue(rest);
      },
    }),
  );
};

/**
 * Starts the bridge and speaks `FrontDoorRpcs` over its stdio until the scope closes, once
 * it says it is ready, saying what an SSO login it waits on first asks for. One that ends
 * first was never a host: where its shell could not find `collie`, the Machine has none.
 */
export const openBridge = Effect.fn("Desktop.openBridge")(function* (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = childEnv(),
  waitingOnSso: WaitingOnSso = () => Effect.void,
) {
  const child = yield* spawned(() =>
    Bun.spawn([...command], { env, cwd: CHILD_CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
  );
  let isReady = false;
  const said = yield* stderrTail(child.stderr, (chunk, said) =>
    Effect.sync(() => process.stderr.write(chunk)).pipe(
      Effect.andThen(!isReady && SSO.test(said) ? waitingOnSso(said) : Effect.void),
    ),
  );
  const ready = Promise.withResolvers<void>();
  const socket = yield* Socket.fromTransformStream(
    Effect.succeed({
      readable: afterReady(child.stdout, () => {
        isReady = true;
        ready.resolve();
      }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          void child.stdin.write(chunk);
          void child.stdin.flush();
        },
        close: () => {
          void child.stdin.end();
        },
      }),
    }),
  );
  const context = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Layer.succeed(Socket.Socket, socket)),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  );
  const door = yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
  const ended = Effect.promise(() => child.exited).pipe(
    Effect.flatMap((code) =>
      Effect.fail<RouteFailure>({
        state: code === NOT_FOUND ? "no-collie" : "unreachable",
        reason: said() || `${command.join(" ")} exited ${code}`,
      }),
    ),
  );
  yield* Effect.raceFirst(
    Effect.promise(() => ready.promise),
    ended,
  );
  return door;
});

export type Door = Effect.Success<ReturnType<typeof openBridge>>;

/**
 * A Machine's two channels: the board's and its actions on one, the Flock chat's tools on
 * the other. They know their Machine, so the chat's tools can name it.
 */
export interface Doors extends BoardSource {
  readonly machine: KnownMachine;
  readonly desktop: Door;
  readonly chat: Door;
}

/** Opens both of a Machine's channels, each a bridge started as its front door. */
export const openDoors = (
  machine: KnownMachine,
  command: (as: Bridged) => ReadonlyArray<string>,
  env = childEnv(),
  waitingOnSso?: WaitingOnSso,
) =>
  Effect.all(
    [
      openBridge(command("desktop"), env, waitingOnSso),
      openBridge(command("chat"), env, waitingOnSso),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([desktop, chat]): Doors => ({
      machine,
      desktop,
      chat,
      board: () => desktop.board(),
    })),
  );

export interface BoardSource {
  readonly machine?: KnownMachine;
  readonly board: () => Stream.Stream<BoardMessage, { readonly message: string }>;
}

/**
 * A Machine's board stream, each message named by its Machine. The host's snapshot comes
 * first and says which installation it is; every change after it is that installation's.
 */
export const machineBoard = (known: KnownMachine, door: BoardSource) =>
  door.board().pipe(
    Stream.mapError((error) => error.message),
    Stream.mapAccum(
      (): Machine => ({ ...known, installation: "" }),
      (machine, message) => {
        const now =
          message._tag === "Snapshot"
            ? { ...machine, installation: message.installation }
            : machine;
        return [now, [{ machine: now, message }]] as const;
      },
    ),
  );

/** What a command printed and how it exited. */
const ran = (command: ReadonlyArray<string>, stdin?: Uint8Array) =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([...command], {
          env: childEnv(),
          cwd: CHILD_CWD,
          stdin: stdin ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) => String(cause),
    });
    const [out, err, code] = yield* Effect.promise(() =>
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
    ).pipe(Effect.onInterrupt(() => Effect.sync(() => child.kill())));
    return { out, err, code };
  });

export type Ran = Effect.Success<ReturnType<typeof ran>>;

export const output = (command: ReadonlyArray<string>) =>
  ran(command).pipe(
    Effect.flatMap(({ out, err, code }) =>
      code === 0
        ? Effect.succeed(out)
        : Effect.fail(err.trim() || `${command.join(" ")} exited ${code}`),
    ),
  );

export type { HerdrMachine } from "../../../src/peers-model";

const NO_SUBCOMMAND = /unrecognized subcommand|unknown (sub)?command|invalid subcommand/i;

/**
 * The machines enabled in herdr. Asked here rather than through `src/herdr.ts`, which
 * would bring Collie's locks into Desktop, as are adding one and removing one.
 */
export const herdrMachines = (herdr: string, minHerdr: string) =>
  output([herdr, "machine", "list", "--json"]).pipe(
    Effect.catch((said) =>
      output([herdr, "--version"]).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((answer) => {
          const version = /\d+\.\d+\.\d+/.exec(answer)?.[0];
          return Effect.fail(
            version !== undefined &&
              Bun.semver.order(version, minHerdr) < 0 &&
              NO_SUBCOMMAND.test(said)
              ? `herdr ${version} has no \`herdr machine\`; Collie needs ${minHerdr} — run \`collie doctor\` on this computer`
              : said,
          );
        }),
      ),
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(HerdrMachines)(json).pipe(Effect.mapError((e) => e.message)),
    ),
    Effect.map((machines) => machines.filter((machine) => machine.enabled)),
  );

/** Drops a machine from herdr's list; nothing on it is stopped or uninstalled. */
export const removeFromHerdr = (herdr: string, profile: string, collie?: ReadonlyArray<string>) =>
  output([herdr, "machine", "remove", profile]).pipe(
    Effect.andThen(() => (collie === undefined ? Effect.void : pairedMachines(collie))),
    Effect.asVoid,
  );

/**
 * One way to reach a Machine: what it is called, and how its bridge is opened, saying
 * what a login it waits on asks for while it waits.
 */
export interface Route<D extends BoardSource = Doors> {
  readonly machine: KnownMachine;
  readonly open: (waitingOnSso: WaitingOnSso) => Effect.Effect<D, RouteFailure, Scope.Scope>;
  /** Runs `collie` on the Machine with these arguments, as its bridge is run. */
  readonly collie: (args: ReadonlyArray<string>) => Effect.Effect<Ran, string>;
}

/** A route that can also run a shell script on its Machine, as onboarding does. */
export interface ShellRoute extends Route {
  /** The command that runs `script` in the Machine's login shell. */
  readonly sh: (script: string) => Effect.Effect<ReadonlyArray<string>, string>;
  /** Makes the Machine's `localhost:<port>` this computer's too, until the scope closes. */
  readonly forward: (port: number) => Effect.Effect<void, string, Scope.Scope>;
  readonly execute?: (script: string, stdin?: Uint8Array) => Effect.Effect<Ran, string>;
  readonly pair?: Effect.Effect<string | null>;
}

const Connected = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Schema.Struct({ path: Schema.String }) }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ message: Schema.String }) }),
  ]),
);

/**
 * Opens the Machine's shared SSH connection with the local `collie machine connect`, saying
 * what an SSO login asks for as it waits, and answers its control path.
 */
const machineConnect = Effect.fn("Desktop.machineConnect")(function* (
  collie: ReadonlyArray<string>,
  label: string,
  waitingOnSso: WaitingOnSso,
) {
  const command = [...collie, "--json", "machine", "connect", label];
  const child = yield* spawned(() =>
    Bun.spawn(command, {
      env: childEnv(),
      cwd: CHILD_CWD,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const said = yield* stderrTail(child.stderr, (_, said) =>
    SSO.test(said) ? waitingOnSso(said) : Effect.void,
  );
  const [out, code] = yield* Effect.promise(() =>
    Promise.all([new Response(child.stdout).text(), child.exited]),
  );
  const answer = Schema.decodeUnknownOption(Connected)(out.trim());
  if (Option.isSome(answer))
    return answer.value.ok
      ? answer.value.data.path
      : yield* Effect.fail(unreachable(answer.value.error.message));
  return yield* Effect.fail(unreachable(said() || `${command.join(" ")} exited ${code}`));
}, Effect.scoped);

/**
 * A herdr Machine over its shared SSH connection, opened through `collie machine connect`
 * when a use finds none open, and never closed here; a lazy one waits for its first use.
 * With `pairs`, it pairs its Machine.
 */
export const remoteRoute = Effect.fn("Desktop.remoteRoute")(function* (
  ssh: string,
  collie: ReadonlyArray<string>,
  machine: HerdrMachine,
  client: string,
  lazy = false,
  pairs = false,
  answerWithin: Duration.Input = MUX_BOUND,
) {
  // Whoever is waiting on the connection now, which the one opened at launch has none of yet:
  // what its login said is kept until it ends, for whoever opens the route while it waits.
  let waiting: WaitingOnSso | undefined;
  let unheard: string | undefined;
  const heard: WaitingOnSso = (said) =>
    waiting === undefined ? Effect.sync(() => void (unheard = said)) : waiting(said);
  let path: string | undefined;
  const asked = (argv: ReadonlyArray<string>) =>
    output(argv).pipe(
      Effect.timeoutOrElse({
        duration: answerWithin,
        orElse: () =>
          Effect.fail(
            `the SSH connection did not answer within ${Duration.format(Duration.fromInputUnsafe(answerWithin))}`,
          ),
      }),
    );
  const connecting = yield* Semaphore.make(1);
  const connected = connecting.withPermits(1)(
    Effect.gen(function* () {
      if (path !== undefined) {
        const checked = yield* asked(muxArgv(ssh, path, "check", machine.target)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (checked) return path;
      }
      path = yield* machineConnect(collie, machine.label, heard).pipe(
        Effect.ensuring(Effect.sync(() => void (unheard = undefined))),
      );
      return path;
    }),
  );
  if (!lazy) yield* connected.pipe(Effect.ignore, Effect.forkScoped);
  const riding = (remote: string) =>
    connected.pipe(Effect.map((at) => riderArgv(at, machine.target, remote, ssh)));
  const used = <A>(effect: Effect.Effect<A, RouteFailure>) =>
    effect.pipe(Effect.mapError(({ reason }) => reason));
  const route: ShellRoute = {
    machine: { profile: machine.id, name: machine.label, target: machine.target, route: "ssh" },
    open: (waitingOnSso) =>
      Effect.gen(function* () {
        let told = false;
        waiting = (said) =>
          told ? Effect.void : Effect.suspend(() => ((told = true), waitingOnSso(said)));
        if (unheard !== undefined) yield* waiting(unheard);
        const at = yield* connected;
        return yield* openDoors(route.machine, (as) =>
          riderArgv(at, machine.target, remoteCollie(bridgeCommand([], client, as)), ssh),
        );
      }),
    collie: (args) => used(riding(remoteCollie(args))).pipe(Effect.flatMap((argv) => ran(argv))),
    sh: (script) => used(riding(`exec "\${SHELL:-/bin/sh}" -lc ${quoted(script)}`)),
    forward: (port) => {
      const spec = ["-L", `${port}:127.0.0.1:${port}`];
      return used(connected).pipe(
        Effect.flatMap((at) =>
          Effect.acquireRelease(asked(muxArgv(ssh, at, "forward", machine.target, ...spec)), () =>
            asked(muxArgv(ssh, at, "cancel", machine.target, ...spec)).pipe(Effect.ignore),
          ),
        ),
        Effect.asVoid,
      );
    },
  };
  if (!pairs) return route;
  let paired = false;
  const pairing = yield* Semaphore.make(1);
  return {
    ...route,
    pair: pairing.withPermits(1)(
      Effect.suspend(() =>
        paired
          ? Effect.succeed(null)
          : used(connected).pipe(
              Effect.andThen(ran([...collie, "--json", "--machine", machine.label, "board"])),
              Effect.flatMap(({ code, out, err }) =>
                code === 0
                  ? Effect.sync(() => {
                      paired = true;
                      return null;
                    })
                  : Effect.fail((err || out).trim()),
              ),
              Effect.catch((reason) =>
                Effect.succeed(`Could not pair ${machine.label}: ${reason}`),
              ),
            ),
      ),
    ),
  } satisfies ShellRoute;
});

/** Local, reached through a bridge it starts without SSH. */
export const localRoute = (
  collie: ReadonlyArray<string>,
  name: string,
  shell: ReadonlyArray<string> = [Bun.env.SHELL ?? "/bin/sh", "-lc"],
): ShellRoute => {
  const machine = { profile: "local", name };
  return {
    machine,
    open: () => openDoors(machine, (as) => bridgeCommand(collie, name, as)),
    collie: (args) => ran([...collie, ...args]),
    sh: (script) => Effect.succeed([...shell, script]),
    // Its localhost is this computer's already.
    forward: () => Effect.void,
  };
};

export const pairedMachines = (collie: ReadonlyArray<string>) =>
  output([...collie, "--json", "machine", "list"]).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            ok: Schema.Literal(true),
            data: Schema.Struct({ machines: Schema.Array(PeerSchema) }),
          }),
        ),
      ),
    ),
    Effect.map(({ data }) => data.machines),
    Effect.orElseSucceed((): ReadonlyArray<PeerView> => []),
  );

export const linkRoute = (
  collie: ReadonlyArray<string>,
  peer: Pick<PeerView, "name">,
  fallback: ShellRoute,
  client: string,
  env = childEnv(),
  initiallyPaired = true,
): ShellRoute => {
  let paired = initiallyPaired;
  const machine: KnownMachine = { ...fallback.machine, route: "link" };
  let doors: Doors | undefined;
  let usingSsh = !paired;
  const execute = (script: string, stdin?: Uint8Array) =>
    Effect.scoped(
      Effect.gen(function* () {
        const door =
          doors?.desktop ??
          (yield* openBridge(bridgeCommand([...collie, "--machine", peer.name], client), env).pipe(
            Effect.mapError(({ reason }) => reason),
          ));
        const asked = {
          script,
          request: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
        };
        const payload =
          stdin === undefined ? asked : { ...asked, stdin: new TextDecoder().decode(stdin) };
        const { code, stdout, stderr } = yield* door
          .shell(payload)
          .pipe(Effect.mapError((cause) => refusal()(cause).reason));
        return { code, out: stdout, err: stderr };
      }).pipe(Effect.provide(BunCrypto.layerSecureRandom)),
    );
  return {
    machine,
    open: (waiting) =>
      (paired
        ? openDoors(
            machine,
            (as) => bridgeCommand([...collie, "--machine", peer.name], client, as),
            env,
            waiting,
          )
        : Effect.fail<RouteFailure>({ state: "unreachable", reason: "not paired yet" })
      ).pipe(
        Effect.tap((opened) =>
          Effect.sync(() => {
            doors = opened;
            usingSsh = false;
          }),
        ),
        Effect.catch(() =>
          fallback.open(waiting).pipe(
            Effect.tap((opened) =>
              Effect.sync(() => {
                doors = opened;
                usingSsh = true;
              }),
            ),
            Effect.map((opened) => ({
              ...opened,
              machine: { ...fallback.machine, route: "ssh" as const },
            })),
          ),
        ),
      ),
    collie: (args) =>
      (usingSsh ? fallback.collie(args) : execute(remoteCollie(args))).pipe(
        Effect.tap((result) => {
          const upgraded = args[0] === "upgrade" || (args[0] === "--json" && args[1] === "upgrade");
          return usingSsh || result.code !== 0 || !upgraded
            ? Effect.void
            : Effect.scoped(
                Effect.gen(function* () {
                  const door =
                    doors?.desktop ??
                    (yield* openBridge(
                      bridgeCommand([...collie, "--machine", peer.name], client),
                      env,
                    ));
                  const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
                  yield* door.refresh({ request: `refresh:${request}` });
                }).pipe(
                  Effect.provide(BunCrypto.layerSecureRandom),
                  Effect.mapError((cause) =>
                    "reason" in cause ? String(cause.reason) : String(cause),
                  ),
                ),
              );
        }),
      ),
    execute: (script, stdin) =>
      usingSsh
        ? Effect.flatMap(fallback.sh(script), (command) => ran(command, stdin))
        : execute(script, stdin),
    sh: fallback.sh,
    forward: fallback.forward,
    pair: fallback.pair?.pipe(
      Effect.tap((failure) =>
        Effect.sync(() => {
          if (failure === null) paired = true;
        }),
      ),
    ),
  };
};

const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * What a Machine's build asks of a Desktop of `version`: a board it cannot read, an upgrade
 * to `version` for a release older than it, or nothing. A development checkout is never
 * upgraded, and any host inside the protocol window is read as it is.
 */
export const buildVerdict = (snapshot: BoardSnapshot, version: string) =>
  snapshot.protocol > PROTOCOL + 1
    ? "update-desktop"
    : snapshot.development === undefined &&
        RELEASE.test(snapshot.build) &&
        RELEASE.test(version) &&
        Bun.semver.order(snapshot.build, version) < 0
      ? "upgrade"
      : "as-is";

const Envelope = Schema.fromJsonString(
  Schema.Struct({ error: Schema.optionalKey(Schema.Struct({ message: Schema.String })) }),
);

/** Moves a released Machine to exactly `version`, or says why it did not, in its own words. */
const upgradeTo = (route: Route<BoardSource>, version: string) =>
  route.collie(["--json", "upgrade", "--to", version]).pipe(
    Effect.flatMap(({ out, err, code }) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            Schema.decodeUnknownOption(Envelope)(out.trim()).pipe(
              Option.flatMap(({ error }) => Option.fromNullishOr(error?.message)),
              Option.getOrElse(() => err.trim() || `collie upgrade exited ${code}`),
            ),
          ),
    ),
  );

/**
 * A route added, one removed, one woken to try again now rather than after its backoff, or
 * one reopened, which asks a Machine's upgrade again.
 */
export type RouteChange<D extends BoardSource = Doors> =
  | { readonly _tag: "Add"; readonly route: Route<D> }
  /** `done` once its stream has ended and its Machine is said to be removed. */
  | { readonly _tag: "Remove"; readonly profile: string; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Wake"; readonly profile: string }
  | { readonly _tag: "Reopen"; readonly profile: string };

/**
 * Every route's board, one stream per installation. Links, then earlier routes, are
 * preferred, so a Machine reached two ways is shown through the first; a route that turns
 * out to reach a Machine already shown says so and ends, and its bridge with it. A route
 * that is not live says why, and tries again with backoff. `doors` holds each shown
 * Machine's door, by installation, for as long as its stream runs. A route added later is
 * preferred below an existing link and above SSH.
 */
export const flockStream = <D extends BoardSource>(
  routes: ReadonlyArray<Route<D>>,
  doors: Map<string, D>,
  version: string,
  changes: Stream.Stream<RouteChange<D>> = Stream.empty,
): Stream.Stream<FlockItem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const owners = yield* Ref.make(
        new Map<string, { readonly at: number; readonly route: KnownMachine["route"] }>(),
      );
      // By each route's place in the order it was added.
      const displaced: Array<Deferred.Deferred<void>> = [];
      const removed: Array<Deferred.Deferred<void>> = [];
      const ended: Array<Deferred.Deferred<void>> = [];
      const wakes: Array<Queue.Queue<void>> = [];
      const reopens: Array<Queue.Queue<void>> = [];
      const places = new Map<string, number>();
      const routeAt: Array<Route<D>> = [];
      // Routes with nothing more to show: merged into another, or too new to read.
      const done = new Set<number>();
      // The installation each merged route reaches, by its place.
      const merged = new Map<number, string>();
      // Asked to upgrade at most once per connection. One that upgraded but did not move is
      // shown as it is; one that failed is asked again when it next connects.
      const upgrading = new Set<string>();
      // Upgrading right now, which a reopen would cut off; the upgrade reopens by itself.
      const upgradingNow = new Set<string>();
      const owns = (at: number, { machine, message }: MachineMessage) =>
        Effect.gen(function* () {
          const [owner, before] = yield* Ref.modify(owners, (now) => {
            const held = now.get(machine.installation);
            const owner = held?.at;
            const takes =
              message._tag === "Snapshot" &&
              (owner === undefined ||
                owner === at ||
                (machine.route === "link" && held?.route !== "link") ||
                ((machine.route === "link") === (held?.route === "link") && at < owner));
            const after = takes
              ? new Map(now).set(machine.installation, { at, route: machine.route })
              : now;
            return [[after.get(machine.installation)?.at, owner] as const, after] as const;
          });
          const lost = before === undefined || before === owner ? undefined : displaced[before];
          if (lost !== undefined) {
            merged.set(before!, machine.installation);
            yield* Deferred.succeed(lost, undefined);
          }
          if (owner !== at) {
            done.add(at);
            merged.set(at, machine.installation);
          }
          return owner === at;
        });
      const tooNew = (route: Route<D>, build: string): RouteFailure => ({
        state: "update-desktop",
        reason: `${route.machine.name} runs collie ${build}, whose board this Desktop (${version}) cannot read.`,
      });
      /**
       * Why a board failed before its first snapshot: one a newer collie serves, which this
       * Desktop cannot decode, or the connection.
       */
      const unreadable = (route: Route<D>, reason: string) =>
        route.collie(["--version"]).pipe(
          Effect.map(({ out }) => /\d+\.\d+\.\d+/.exec(out)?.[0]),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((build) =>
            Effect.fail(
              build !== undefined && RELEASE.test(version) && Bun.semver.order(build, version) > 0
                ? tooNew(route, build)
                : unreachable(reason),
            ),
          ),
        );
      const live = (route: Route<D>, at: number, waitingOnSso: WaitingOnSso) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // A reopen asked while it was not live is this opening.
            yield* Queue.clear(reopens[at]!);
            const door = yield* route.open(waitingOnSso);
            // The build of a release older than Desktop, once its board is shown.
            const due = yield* Deferred.make<{
              readonly installation: string;
              readonly from: string;
            }>();
            let shown = false;
            const board = machineBoard(door.machine ?? route.machine, door).pipe(
              Stream.tap(() => Effect.sync(() => void (shown = true))),
              Stream.catch((reason) =>
                Stream.fromEffect(
                  shown ? Effect.fail(unreachable(reason)) : unreadable(route, reason),
                ),
              ),
              Stream.mapEffect((item) =>
                item.message._tag === "Snapshot" &&
                buildVerdict(item.message, version) === "update-desktop"
                  ? Effect.fail(tooNew(route, item.message.build))
                  : Effect.succeed(item),
              ),
              Stream.mapEffect((item): Effect.Effect<MachineMessage | MachineMerged> =>
                Effect.map(owns(at, item), (mine) =>
                  mine ? item : { _tag: "Merged", machine: route.machine },
                ),
              ),
              Stream.takeUntil((item) => "_tag" in item),
              Stream.tap((item) =>
                Effect.gen(function* () {
                  if ("_tag" in item) return;
                  const { machine, message } = item;
                  doors.set(machine.installation, door);
                  if (
                    message._tag !== "Snapshot" ||
                    buildVerdict(message, version) !== "upgrade" ||
                    upgrading.has(machine.installation) ||
                    (yield* Deferred.isDone(due))
                  )
                    return;
                  upgrading.add(machine.installation);
                  yield* Deferred.succeed(due, {
                    installation: machine.installation,
                    from: message.build,
                  });
                }),
              ),
              Stream.ensuring(
                Effect.sync(() => {
                  for (const [installation, held] of doors)
                    if (held === door) doors.delete(installation);
                }),
              ),
            );
            // Beside the board, which stays live while the Machine upgrades.
            const upgrade = Stream.unwrap(
              Effect.map(Deferred.await(due), ({ installation, from }) =>
                upgradeThenReopen(route, installation, from),
              ),
            );
            return Stream.merge(board, upgrade, { haltStrategy: "left" }).pipe(
              Stream.interruptWhen(
                Queue.take(reopens[at]!).pipe(
                  Effect.andThen(Effect.fail<RouteFailure>({ state: "reopen", reason: "asked" })),
                ),
              ),
            );
          }),
        );
      const notice = (route: Route<D>, text: string): FlockItem => ({
        _tag: "Notice",
        machine: route.machine,
        text,
      });
      /** Upgrades the Machine, then opens it again so its new build replaces its host. */
      const upgradeThenReopen = (route: Route<D>, installation: string, from: string) =>
        Stream.unwrap(
          Effect.sync(() => upgradingNow.add(installation)).pipe(
            Effect.andThen(upgradeTo(route, version)),
            Effect.ensuring(Effect.sync(() => upgradingNow.delete(installation))),
            // Failed, or cut off with its connection: asked again when it next connects.
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.sync(() => upgrading.delete(installation)),
            ),
            Effect.match({
              onSuccess: () =>
                Stream.make(
                  notice(route, `${route.machine.name} upgraded ${from} → ${version}`),
                ).pipe(
                  Stream.concat(Stream.fail<RouteFailure>({ state: "reopen", reason: "upgraded" })),
                ),
              onFailure: (reason) =>
                Stream.make(
                  notice(route, `Could not upgrade ${route.machine.name} to ${version}: ${reason}`),
                ),
            }),
          ),
        );
      const lostItem = (route: Route<D>, state: NotLive, reason: string) =>
        Effect.map(Clock.currentTimeMillis, (now): FlockItem => ({
          _tag: "Lost",
          machine: route.machine,
          state,
          reason,
          at: now,
        }));
      const tries = (route: Route<D>, at: number, notices: Queue.Queue<FlockItem>) => {
        const waitingOnSso = (reason: string) =>
          Effect.flatMap(lostItem(route, "sso", reason), (item) => Queue.offer(notices, item));
        const afterFailures = (failures: number): Stream.Stream<FlockItem> =>
          Stream.suspend(() => {
            let reached = false;
            return live(route, at, waitingOnSso).pipe(
              Stream.tap(() => Effect.sync(() => void (reached = true))),
              Stream.concat(
                Stream.fail(unreachable(`${route.machine.name} closed the connection`)),
              ),
              Stream.catch((failure) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    // A route that reaches a Machine already shown is not lost: it is done.
                    if (done.has(at) || (yield* Deferred.isDone(displaced[at]!)))
                      return Stream.empty;
                    if (failure.state === "reopen")
                      return Stream.unwrap(
                        // A reopen wakes a route in backoff; one that was live needs no wake.
                        Effect.as(Queue.clear(wakes[at]!), afterFailures(0)),
                      ).pipe(
                        Stream.prepend<FlockItem>([
                          {
                            _tag: "Reconnecting",
                            machine: route.machine,
                            at: yield* Clock.currentTimeMillis,
                          },
                        ]),
                      );
                    const lost = Stream.fromEffect(lostItem(route, failure.state, failure.reason));
                    if (failure.state === "update-desktop") {
                      done.add(at);
                      return lost;
                    }
                    const again = reached ? 0 : failures;
                    const waited = Effect.raceFirst(
                      Effect.sleep(backoff(again)),
                      Queue.take(wakes[at]!),
                    );
                    return lost.pipe(
                      Stream.concat(Stream.fromEffectDrain(waited)),
                      Stream.concat(afterFailures(again + 1)),
                    );
                  }),
                ),
              ),
            );
          });
        return afterFailures(0);
      };
      const added = (route: Route<D>) =>
        Effect.gen(function* () {
          const at = displaced.length;
          displaced.push(yield* Deferred.make<void>());
          removed.push(yield* Deferred.make<void>());
          ended.push(yield* Deferred.make<void>());
          wakes.push(yield* Queue.sliding<void>(1));
          reopens.push(yield* Queue.sliding<void>(1));
          places.set(route.machine.profile, at);
          routeAt.push(route);
          const notices = yield* Queue.unbounded<FlockItem>();
          return Stream.merge(Stream.fromQueue(notices), tries(route, at, notices), {
            haltStrategy: "right",
          }).pipe(
            Stream.interruptWhen(
              Effect.raceFirst(Deferred.await(displaced[at]!), Deferred.await(removed[at]!)),
            ),
            Stream.ensuring(Deferred.succeed(ended[at]!, undefined)),
          );
        });
      const removedAt = (place: number) => places.get(routeAt[place]!.machine.profile) !== place;
      const changed = (change: RouteChange<D>): Stream.Stream<FlockItem> => {
        if (change._tag === "Add")
          return places.has(change.route.machine.profile)
            ? Stream.empty
            : Stream.unwrap(added(change.route));
        const at = places.get(change.profile);
        if (change._tag === "Wake")
          return at === undefined
            ? Stream.empty
            : Stream.fromEffectDrain(Queue.offer(wakes[at]!, undefined));
        if (change._tag === "Reopen")
          return at === undefined
            ? Stream.empty
            : Stream.fromEffectDrain(
                Effect.gen(function* () {
                  const owned = [...(yield* Ref.get(owners))]
                    .filter(([, owner]) => owner.at === at)
                    .map(([installation]) => installation);
                  if (owned.some((installation) => upgradingNow.has(installation))) return;
                  // Asked again even where the last upgrade succeeded and did not move.
                  for (const installation of owned) upgrading.delete(installation);
                  yield* Queue.offer(reopens[at]!, undefined);
                  yield* Queue.offer(wakes[at]!, undefined);
                }),
              );
        if (at === undefined)
          return Stream.fromEffectDrain(Deferred.succeed(change.done, undefined));
        places.delete(change.profile);
        done.add(at);
        const shown = new Set<string>();
        const removal = Stream.fromEffect(
          Effect.gen(function* () {
            yield* Ref.update(owners, (now) => {
              const kept = new Map(now);
              for (const [installation, owner] of now)
                if (owner.at === at) {
                  shown.add(installation);
                  kept.delete(installation);
                }
              return kept;
            });
            yield* Deferred.succeed(removed[at]!, undefined);
            yield* Deferred.await(ended[at]!);
            return { _tag: "Removed", machine: routeAt[at]!.machine } satisfies FlockItem;
          }),
        ).pipe(Stream.ensuring(Deferred.succeed(change.done, undefined)));
        // A route that merged into this one's Machine shows it now, as a route added afresh.
        const again = Stream.suspend(() =>
          Stream.mergeAll(
            [...merged]
              .filter(([place, installation]) => shown.has(installation) && !removedAt(place))
              .map(([place]) => {
                merged.delete(place);
                const route = routeAt[place]!;
                places.delete(route.machine.profile);
                return Stream.unwrap(added(route));
              }),
            { concurrency: "unbounded" },
          ),
        );
        return removal.pipe(Stream.concat(again));
      };
      return Stream.fromIterable(routes).pipe(
        Stream.map((route): RouteChange<D> => ({ _tag: "Add", route })),
        Stream.concat(changes),
        Stream.flatMap(changed, { concurrency: "unbounded" }),
      );
    }),
  );

type Refused =
  | HostRefused
  | ProposalRefused
  | RequestConflict
  | RpcClientError.RpcClientError
  | Unsteered
  | Unconfirmed;

/** Why a host said no, in its own words, under the request it was asked as. */
const refusal = (request?: string) => (error: Refused) =>
  new ActionFailed({
    request,
    reason:
      error._tag === "HostRefused" ||
      error._tag === "RequestConflict" ||
      error._tag === "Unconfirmed"
        ? error.reason
        : error._tag === "ProposalRefused"
          ? error.detail
          : error.message,
  });

export type Reached = Pick<Doors, "machine" | "desktop">;

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * A call over a Machine's door, its refusal said, and its door closing under it or its
 * payload or reply not fitting the call a failure naming the Machine. The caller's own
 * interrupt is not caught.
 */
const over = <A, R>(
  { machine }: Reached,
  call: Effect.Effect<A, Refused, R>,
  request?: string,
): Effect.Effect<A, ActionFailed, R> =>
  call.pipe(
    Effect.mapError(refusal(request)),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause))
        return Effect.fail(
          new ActionFailed({
            request,
            reason: `${machine.name}'s connection was renewed before this finished`,
          }),
        );
      const misfit = cause.reasons.find(Cause.isDieReason)?.defect;
      // The RPC client dies on a misfit, its schema issue as the defect's cause.
      return Predicate.isError(misfit) && SchemaIssue.isIssue(misfit.cause)
        ? Effect.fail(
            new ActionFailed({
              request,
              reason: `The call to ${machine.name} did not fit its schema: ${formatIssue(misfit.cause).replace(/\s+/g, " ")}`,
            }),
          )
        : Effect.failCause(cause);
    }),
  );

/** A steer the host carried no further, with what it said about it. */
interface Unsteered {
  readonly _tag: "Unsteered";
  readonly message: string;
}

/** What a board action is about, and the words a sentence names it with. */
const aboutOf = (action: DesktopAction) => {
  switch (action._tag) {
    case "Confirm":
      return { about: action.proposal, what: `the confirmation of ${action.proposal}` };
    case "Decline":
      return { about: action.proposal, what: `the decline of ${action.proposal}` };
    case "Control":
      return { about: action.runId, what: `the ${action.control} of ${action.runId}` };
    default:
      return {
        about: action.runId,
        what: `the ${action._tag === "FollowUp" ? "follow-up" : action._tag.toLowerCase()} to ${action.runId}`,
      };
  }
};

/** One board action carried out on a Machine's host, and what it came to in a line. */
export const act = (
  reached: Reached,
  request: string,
  action: DesktopAction,
  log: ActionsLog = unlogged,
) => {
  const door = reached.desktop;
  // Set from the reply of a write the host takes once, false for one it had already taken.
  let fresh = true;
  const freshly = <T extends { readonly fresh: boolean }>(reply: T) => {
    fresh = reply.fresh;
    return reply;
  };
  const said: Effect.Effect<string, Exclude<Refused, Unconfirmed>> = (() => {
    switch (action._tag) {
      case "Answer":
        return door
          .answer({ runId: action.runId, decision: action.decision, value: action.value, request })
          .pipe(
            Effect.map(freshly),
            Effect.map((done) => withNotice(`Answered ${action.runId}`, done.redacted, ". ")),
          );
      case "Control": {
        const verb = action.control === "stop" ? "Stopped" : action.set ? "Held" : "Released";
        return door
          .control({
            runId: action.runId,
            control: action.control,
            set: action.set,
            request,
            before: action.before,
          })
          .pipe(
            Effect.flatMap((done) => {
              const left = leftSaid(done);
              return left === null
                ? Effect.succeed(done.detail || `${verb} ${action.runId}`)
                : Effect.fail(new HostRefused({ reason: left }));
            }),
          );
      }
      case "Resume":
        return door
          .resume({ runId: action.runId, request })
          .pipe(
            Effect.flatMap((done) =>
              done.applied
                ? Effect.succeed(done.detail || `Resumed ${action.runId}`)
                : Effect.fail(new HostRefused({ reason: done.detail })),
            ),
          );
      case "Confirm":
        return door
          .confirm({ proposal: action.proposal, hash: action.hash, request })
          .pipe(Effect.as("Confirmed"));
      case "Decline":
        return door
          .decline({ proposal: action.proposal, hash: action.hash, request })
          .pipe(Effect.as("Declined"));
      case "Dispose":
        return door
          .dispose({ runId: action.runId, kind: action.kind, ref: action.ref, note: null, request })
          .pipe(Effect.as(`Marked ${action.kind}`));
      case "Seen":
        return door.seen({ runId: action.runId, request }).pipe(Effect.as("Seen"));
      case "Steer":
        return door
          .steerAbout({
            runId: action.runId,
            text: action.text,
            from: null,
            dryRun: false,
            request,
          })
          .pipe(
            Effect.flatMap((outcome) =>
              outcome.ok
                ? Effect.succeed(outcome.human)
                : Effect.fail<Unsteered>({ _tag: "Unsteered", message: outcome.human }),
            ),
          );
      case "WithdrawNote":
        return door
          .withdrawNote({ runId: action.runId, note: action.note, request })
          .pipe(Effect.as("Note removed"));
      case "Deliver": {
        const deliver: Mutable<Extract<typeof ActionSchema.Encoded, { kind: "deliver" }>> = {
          kind: "deliver",
          run: action.runId,
          ...addressOf(action),
          text: action.text,
        };
        // JSON has no undefined: an absent step is left out.
        if (action.step !== undefined) deliver.step = action.step;
        return door.act({ actions: [deliver], request }).pipe(
          Effect.flatMap(([done]) =>
            done?.state === "applied"
              ? Effect.succeed(done.note || "Sent")
              : Effect.fail<Unsteered>({
                  _tag: "Unsteered",
                  message: done?.note || "the host said nothing about it",
                }),
          ),
        );
      }
      case "FollowUp":
        return door.followUp({ runId: action.runId, text: action.text, request }).pipe(
          Effect.map(freshly),
          Effect.map((started) => withNotice(`Started ${started.runId}`, started.redacted, ". ")),
        );
      case "Invoke":
        return door
          .invoke({ runId: action.runId, offer: action.offer, input: action.input, request })
          .pipe(
            Effect.map(freshly),
            Effect.map((started) => withNotice(`Started ${started.runId}`, started.redacted, ". ")),
          );
    }
  })();
  const sending = {
    log,
    door: "board" as const,
    machine: reached.machine.name,
    request,
    kind: action._tag,
    withheld: withheldOf(action),
  };
  return over(
    reached,
    confirmed({ ...sending, ...aboutOf(action) }, said, () => !fresh),
    request,
  );
};

/**
 * A board action on the Machine an installation id names, or why Desktop did not send it:
 * `unsent` is the view's reason, as for a card on a saved board.
 */
export const actOn = (
  doors: ReadonlyMap<string, Reached>,
  installation: string,
  request: string,
  action: DesktopAction,
  log: ActionsLog,
  unsent?: string,
) => {
  const door = doors.get(installation);
  const why = unsent ?? (door === undefined ? "that Machine is not connected" : undefined);
  if (why === undefined) return act(door!, request, action, log);
  const machine = door?.machine.name ?? installation;
  const { about } = aboutOf(action);
  return log({
    door: "board",
    machine,
    request,
    kind: action._tag,
    about,
    attempt: 0,
    ended: "not-sent",
    reason: why,
  }).pipe(
    Effect.andThen(
      Effect.fail(new ActionFailed({ request, reason: `Not sent to ${machine}: ${why}.` })),
    ),
  );
};

/** The door to the Machine an installation id names, while Desktop shows it. */
export const doorTo = <D>(
  doors: ReadonlyMap<string, D>,
  installation: string,
): Effect.Effect<D, ActionFailed> => {
  const door = doors.get(installation);
  return door === undefined
    ? Effect.fail(new ActionFailed({ reason: "that Machine is not connected" }))
    : Effect.succeed(door);
};

/** Focuses `agent` of `runId` where one is chosen, else the Run's newest live agent. */
export const focusOn = (door: Reached, request: string, runId: string, agent?: string) =>
  over(
    door,
    door.desktop.focus(agent === undefined ? { runId, request } : { runId, agent, request }),
    request,
  );

export const offersOn = (door: Reached, runId: string) =>
  over(door, door.desktop.offers({ runId }));

/** Its host's Workflows and Personas; a refusal names the Machine. */
export const definitionsIn = (doors: ReadonlyMap<string, Reached>, installation: string) =>
  doorTo(doors, installation).pipe(
    Effect.flatMap((door) =>
      over(door, door.desktop.definitions()).pipe(
        Effect.mapError(
          (failed) =>
            new ActionFailed({ ...failed, reason: `${door.machine.name}: ${failed.reason}` }),
        ),
      ),
    ),
  );

/** Each shown Machine's door by installation, which wakes whoever waits on it to change. */
export class DoorMap<D> extends Map<string, D> {
  #changed = Deferred.makeUnsafe<void>();
  /** Done at the next change after it was read. */
  get changed() {
    return this.#changed;
  }
  override set(installation: string, door: D) {
    if (this.get(installation) === door) return this;
    super.set(installation, door);
    return this.#wake();
  }
  override delete(installation: string) {
    if (!super.delete(installation)) return false;
    this.#wake();
    return true;
  }
  #wake() {
    Deferred.doneUnsafe(this.#changed, Exit.void);
    this.#changed = Deferred.makeUnsafe<void>();
    return this;
  }
}

/** The Machine's door once it has one other than `last`. */
const nextDoor = <D>(doors: DoorMap<D>, installation: string, last?: D): Effect.Effect<D> =>
  Effect.suspend(() => {
    const changed = doors.changed;
    const door = doors.get(installation);
    return door !== undefined && door !== last
      ? Effect.succeed(door)
      : Deferred.await(changed).pipe(Effect.andThen(nextDoor(doors, installation, last)));
  });

/**
 * A Run's details over whichever door its Machine has now: when that door closes or breaks,
 * again over the next. It ends only when let go, the host fails it, or its door breaks and
 * stays.
 */
export const runDetailOn = (doors: DoorMap<Reached>, installation: string, runId: string) => {
  const after = (last?: Reached): Stream.Stream<RunDetail | null, ActionFailed> =>
    Stream.unwrap(
      Effect.map(nextDoor(doors, installation, last), (door) =>
        door.desktop.runDetail({ runId, tail: true, pages: 1, refreshMr: false }).pipe(
          // A broken connection's door is replaced soon after; one that stays was not.
          Stream.catchTag("RpcClientError", (error) =>
            Stream.fromEffectDrain(
              nextDoor(doors, installation, door).pipe(
                Effect.timeoutOrElse({
                  duration: "5 seconds",
                  orElse: () => Effect.fail(error),
                }),
              ),
            ),
          ),
          Stream.mapError(refusal()),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.concat(Stream.suspend(() => after(door))),
        ),
      ),
    );
  return after();
};

export const runFileOn = (door: Reached, runId: string, ref: string, offset?: number) =>
  over(door, door.desktop.runFile({ runId, ref, offset }));

/** What a Machine's host read of its Usage; a host too old to have the call asks for an upgrade. */
export const usageOn = (
  { profile, name }: KnownMachine,
  door: Pick<Door, "usage">,
): Effect.Effect<MachineUsage> =>
  door.usage().pipe(
    Effect.map((readings) => ({ profile, name, readings, problem: null })),
    Effect.mapError(refusal()),
    // One Machine that does not answer must not hold back the others'.
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new ActionFailed({ reason: "its host did not answer in time" })),
    }),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const failed = Cause.findErrorOption(cause);
      const defect = Cause.findDefect(cause);
      const problem = Option.isSome(failed)
        ? failed.value.reason
        : defect._tag === "Success" && String(defect.success).startsWith("Unknown request tag")
          ? UPGRADE_SAID
          : Cause.pretty(cause).split("\n")[0]!;
      return Effect.succeed({ profile, name, readings: [], problem });
    }),
  );

/**
 * What a Machine's host listed of its Schedules. A host too old to have the call asks for an
 * upgrade; one that does not answer is unreachable, which stops none of its Schedules.
 */
export const schedulesOn = (
  { installation, profile, name }: KnownMachine & { readonly installation: string },
  door: Pick<Door, "schedules">,
): Effect.Effect<MachineSchedules> => {
  const read = (over: Partial<MachineSchedules>): MachineSchedules => ({
    installation,
    profile,
    name,
    schedules: [],
    problem: null,
    unreachable: false,
    ...over,
  });
  return door.schedules().pipe(
    Effect.map(({ schedules }) => read({ schedules })),
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.succeed(read({ unreachable: true, problem: "its host did not answer in time" })),
    }),
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === "HostRefused"
          ? read({ problem: error.reason })
          : read({ unreachable: true, problem: error.message }),
      ),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const defect = Cause.findDefect(cause);
      return Effect.succeed(
        defect._tag === "Success" && String(defect.success).startsWith("Unknown request tag")
          ? read({ problem: SCHEDULES_UPGRADE_SAID })
          : read({ unreachable: true, problem: Cause.pretty(cause).split("\n")[0]! }),
      );
    }),
  );
};

/**
 * What a sweep would remove now on the Machine with `profile`, asked over its door and again
 * over the next one whenever a door closes or breaks under the call, for 2 minutes in all. A
 * host too old to have the call asks for an upgrade.
 */
export const cleanupOn = (
  doors: DoorMap<Reached>,
  profile: string,
): Effect.Effect<CleanupListing, ActionFailed> =>
  Effect.suspend(() => {
    const failed = (reason: string) => Effect.fail(new ActionFailed({ reason }));
    const found = [...doors].find(([, door]) => door.machine.profile === profile);
    if (found === undefined) return failed("That Machine isn't connected.");
    const [installation, first] = found;
    let waiting = false;
    const askOver = (door: Reached): Effect.Effect<CleanupReport, ActionFailed> =>
      Effect.suspend(() => {
        waiting = false;
        return Effect.exit(door.desktop.cleanup());
      }).pipe(
        // Its caller letting go is not caught; the door closing under it is.
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
          const error = Cause.findErrorOption(exit.cause);
          if (
            Cause.hasInterruptsOnly(exit.cause) ||
            (Option.isSome(error) && error.value._tag === "RpcClientError")
          )
            return Effect.suspend(() => {
              waiting = true;
              return nextDoor(doors, installation, door);
            }).pipe(Effect.flatMap(askOver));
          if (Option.isSome(error))
            return failed(
              error.value._tag === "HostRefused" ? error.value.reason : error.value.message,
            );
          const defect = Cause.findDefect(exit.cause);
          return failed(
            defect._tag === "Success" && String(defect.success).startsWith("Unknown request tag")
              ? CLEANUP_UPGRADE_SAID
              : Cause.pretty(exit.cause).split("\n")[0]!,
          );
        }),
      );
    return askOver(first).pipe(
      Effect.timeoutOrElse({
        duration: "2 minutes",
        orElse: () =>
          failed(
            waiting
              ? "its connection did not come back within 2 minutes"
              : "its host did not answer within 2 minutes",
          ),
      }),
      Effect.map((report) => ({ installation, report })),
    );
  });

/**
 * Sweeps the Machine now under `request`, sent again under it only over the door that follows
 * one closed or broken under the send, for 10 minutes in all: the host sweeps once per request.
 */
export const sweepOn = (
  doors: DoorMap<Reached>,
  { installation, machine }: { readonly installation: string; readonly machine: string },
  request: string,
  log: ActionsLog,
): Effect.Effect<CleanupReport, ActionFailed> =>
  Effect.suspend(() => {
    const door = doors.get(installation);
    const name = door?.machine.name ?? machine;
    const sending = {
      door: "board",
      machine: name,
      request,
      kind: "cleanup",
      about: null,
    } as const;
    const note = (attempt: number, ended: Attempted["ended"], reason?: string) =>
      log(
        reason === undefined
          ? { ...sending, attempt, ended }
          : { ...sending, attempt, ended, reason },
      );
    const failed = (attempt: number, ended: Attempted["ended"], reason: string, logged = reason) =>
      note(attempt, ended, logged).pipe(
        Effect.andThen(Effect.fail(new ActionFailed({ request, reason }))),
      );
    if (door === undefined)
      return failed(
        0,
        "not-sent",
        `Not sent to ${name}: that Machine is not connected.`,
        "that Machine is not connected",
      );
    let attempt = 0;
    let waiting = false;
    const sendOver = (door: Reached): Effect.Effect<CleanupReport, ActionFailed> =>
      Effect.suspend(() => {
        attempt += 1;
        waiting = false;
        return Effect.exit(door.desktop.sweep({ request }));
      }).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return note(attempt, "accepted").pipe(Effect.as(exit.value));
          const error = Cause.findErrorOption(exit.cause);
          const lost = Cause.hasInterruptsOnly(exit.cause)
            ? "the connection was renewed before this finished"
            : Option.isSome(error) && error.value._tag === "RpcClientError"
              ? reasonOf(error.value)
              : undefined;
          if (lost !== undefined)
            return note(attempt, "failed", lost).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  waiting = true;
                  return nextDoor(doors, installation, door);
                }),
              ),
              Effect.flatMap(sendOver),
            );
          return Option.isSome(error)
            ? failed(attempt, "refused", reasonOf(error.value))
            : // SAFETY: with no error in it, the cause holds only defects and interrupts.
              Effect.failCause(exit.cause as Cause.Cause<never>);
        }),
      );
    const timedOut = `${name} did not finish cleaning up within 10 minutes. It may still be sweeping; Try again asks for the same sweep.`;
    return sendOver(door).pipe(
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () =>
          waiting
            ? failed(attempt + 1, "not-sent", timedOut, "it did not reconnect within 10 minutes")
            : failed(attempt, "timed-out", timedOut),
      }),
    );
  });

/** A pause, resume or removal of one of the Machine's Schedules, under its own request. */
export const changeScheduleOn = (door: Reached, change: ScheduleChange, request: string) =>
  over(door, door.desktop.changeSchedule({ change, request }), request);

const scheduleDoor = (door: Reached): ScheduleDoor => ({
  name: door.machine.name,
  schedules: () => door.desktop.schedules(),
  changeSchedule: (asked) => door.desktop.changeSchedule(asked),
});

/** Moves a Schedule between two Machines' hosts through the one shared sequence. */
export const moveScheduleOn = (
  asked: {
    readonly from: Reached;
    readonly to: Reached;
    readonly name: string;
    readonly checkout: string | undefined;
  },
  request: string,
) =>
  moveSchedule({
    from: scheduleDoor(asked.from),
    to: scheduleDoor(asked.to),
    name: asked.name,
    request,
    checkout: asked.checkout,
  }).pipe(
    Effect.flatMap((moved) =>
      moved.ok
        ? Effect.succeed(moved.said)
        : Effect.fail(new ActionFailed({ request, reason: `${moved.code}: ${moved.message}` })),
    ),
  );

/** What connecting would do for a Machine that lags on `behind`, and whether any of it failed. */
export const syncNow = (
  machine: KnownMachine,
  behind: ReadonlyArray<Lag["part"]>,
  steps: {
    readonly reopen: Effect.Effect<unknown>;
    readonly sync: Effect.Effect<string | null>;
    readonly syncDefinitions: Effect.Effect<string | null>;
    readonly give: Effect.Effect<
      ReadonlyArray<{ readonly credential: Credential; readonly failed: string | null }>
    >;
  },
) =>
  Effect.gen(function* () {
    if (behind.includes("version")) {
      yield* steps.reopen;
      return {
        said: `Reopening ${machine.name} to upgrade it; its settings, definitions and credentials follow once it connects`,
        failed: false,
      };
    }
    const failed = yield* steps.sync;
    const unshared = yield* steps.syncDefinitions;
    const gave = yield* steps.give;
    const said = [
      `${machine.name}: ${failed === null ? "settings synced" : `settings didn't sync: ${failed}`}`,
      unshared === null ? "definitions synced" : `definitions didn't sync: ${unshared}`,
      ...gave.map(({ credential, failed: why }) =>
        why === null
          ? `${CREDENTIAL_SAID[credential].lacks} given`
          : `${CREDENTIAL_SAID[credential].lacks} not given: ${why}`,
      ),
    ].join("; ");
    return {
      said,
      failed: failed !== null || unshared !== null || gave.some(({ failed: why }) => why !== null),
    };
  });

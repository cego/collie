// Desktop's channels to a Machine's host: bridge commands started as `desktop` and as
// `chat`, whose output after the ready marker is the host's socket. Never Collie's own host
// client: over a channel that would start a host on this computer, or signal a pid that is
// not its own.

import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  BRIDGE_READY,
  type BoardMessage,
  type BoardSnapshot,
  PROTOCOL,
  FrontDoorRpcs,
  type HostRefused,
  type ProposalRefused,
  type RequestConflict,
} from "../../../src/board-model";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  ActionFailed,
  type DesktopAction,
  type FlockItem,
  type KnownMachine,
  type Machine,
  type MachineMerged,
  type MachineMessage,
  type NotLive,
} from "../shared/flock";

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

/** The last of what a process has said on a stream so far, each chunk passed on as it comes. */
export const stderrTail = Effect.fnUntraced(function* (
  from: ReadableStream<Uint8Array>,
  echo: (chunk: Uint8Array) => void = () => {},
) {
  let text = "";
  const decoder = new TextDecoder();
  yield* Stream.fromReadableStream({ evaluate: () => from, onError: () => undefined }).pipe(
    Stream.runForEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        echo(chunk);
        text = (text + decoder.decode(chunk, { stream: true })).slice(-4000);
      }),
    ),
    Effect.ignore,
    // Ends with its process.
    Effect.forkDetach,
  );
  return () => text.trim();
});

/** Told what an SSO login a master waits on asks for. */
export type WaitingOnSso = (said: string) => Effect.Effect<void>;

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
 * it says it is ready. One that ends first was never a host: where its shell could not find
 * `collie`, the Machine has none.
 */
export const openBridge = Effect.fn("Desktop.openBridge")(function* (
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  const child = yield* spawned(() =>
    Bun.spawn([...command], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
  );
  const said = yield* stderrTail(child.stderr, (chunk) => process.stderr.write(chunk));
  const ready = Promise.withResolvers<void>();
  const socket = yield* Socket.fromTransformStream(
    Effect.succeed({
      readable: afterReady(child.stdout, ready.resolve),
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
export const openDoors = (machine: KnownMachine, command: (as: Bridged) => ReadonlyArray<string>) =>
  Effect.all([openBridge(command("desktop")), openBridge(command("chat"))], {
    concurrency: "unbounded",
  }).pipe(
    Effect.map(([desktop, chat]): Doors => ({
      machine,
      desktop,
      chat,
      board: () => desktop.board(),
    })),
  );

export interface BoardSource {
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
const ran = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () => Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      catch: (cause) => String(cause),
    });
    const [out, err, code] = yield* Effect.promise(() =>
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
    );
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

/** A saved herdr machine, as `herdr machine list --json` lists it. */
const HerdrMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
});
export type HerdrMachine = typeof HerdrMachine.Type;
const HerdrMachines = Schema.fromJsonString(Schema.Array(HerdrMachine));

/**
 * The machines enabled in herdr. Asked here rather than through `src/herdr.ts`, which
 * would bring Collie's locks into Desktop, as are adding one and removing one.
 */
export const herdrMachines = (herdr: string) =>
  output([herdr, "machine", "list", "--json"]).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(HerdrMachines)(json).pipe(Effect.mapError((e) => e.message)),
    ),
    Effect.map((machines) => machines.filter((machine) => machine.enabled)),
  );

/** Drops a machine from herdr's list; nothing on it is stopped or uninstalled. */
export const removeFromHerdr = (herdr: string, profile: string) =>
  output([herdr, "machine", "remove", profile]).pipe(Effect.asVoid);

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

export const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** `collie` as the Machine's login shell runs it, as Local's is. */
const remoteCollie = (args: ReadonlyArray<string>) =>
  [`exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`, ...args.map(quoted)].join(" ");

/** A route that can also run a shell script on its Machine, as onboarding does. */
export interface ShellRoute extends Route {
  /** The command that runs `script` in the Machine's login shell. */
  readonly sh: (script: string) => Effect.Effect<ReadonlyArray<string>, string>;
  /** Makes the Machine's `localhost:<port>` this computer's too, until the scope closes. */
  readonly forward: (port: number) => Effect.Effect<void, string, Scope.Scope>;
}

/** What an SSO login that ssh is waiting on prints before it, as vm-mk's sshd does. */
const SSO = /\bSSO\b/;

/**
 * Starts a master to the machine, held until the scope closes, and waits until it is open,
 * saying what an SSO login asks for each time it finds the master still waiting on one.
 * The user's SSH config applies, and SSO is asked once, here, rather than for every channel.
 */
const openMaster = Effect.fn("Desktop.openMaster")(function* (
  ssh: string,
  control: string,
  target: string,
  waitingOnSso: WaitingOnSso,
) {
  const master = yield* spawned(() =>
    Bun.spawn([ssh, "-M", "-N", "-S", control, "-o", "ControlPersist=no", target], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const said = yield* stderrTail(master.stderr);
  const ended = Effect.promise(() => master.exited).pipe(
    Effect.map((code) => said() || `ssh to ${target} exited ${code}`),
  );
  yield* output([ssh, "-S", control, "-O", "check", target]).pipe(
    Effect.tapError(() => (SSO.test(said()) ? waitingOnSso(said()) : Effect.void)),
    Effect.retry({
      while: () => master.exitCode === null,
      schedule: Schedule.spaced("200 millis"),
    }),
    // Only a master that has ended stops the checks, and what it said is why.
    Effect.catch(() => ended.pipe(Effect.flatMap((reason) => Effect.fail(unreachable(reason))))),
  );
  return master;
});

/**
 * A route through a herdr machine. Its master opens now and lives as long as the scope,
 * and again on the next try after it drops; each bridge is one more channel on it.
 */
export const remoteRoute = Effect.fn("Desktop.remoteRoute")(function* (
  ssh: string,
  control: string,
  machine: HerdrMachine,
  client: string,
) {
  const scope = yield* Effect.scope;
  // Whoever is waiting on the master now, which the one started at launch has none of yet.
  let waiting: WaitingOnSso = () => Effect.void;
  const start = openMaster(ssh, control, machine.target, (said) => waiting(said)).pipe(
    Effect.forkIn(scope),
  );
  let master = yield* start;
  // Never a login of its own: SSO is asked once, by the master.
  const channel = (remote: string) => [
    ssh,
    "-S",
    control,
    "-o",
    "ControlMaster=no",
    "-T",
    machine.target,
    remote,
  ];
  const route: ShellRoute = {
    machine: { profile: machine.id, name: machine.label, target: machine.target },
    open: (waitingOnSso) =>
      Effect.gen(function* () {
        let told = false;
        waiting = (said) =>
          told ? Effect.void : Effect.suspend(() => ((told = true), waitingOnSso(said)));
        const done = master.pollUnsafe();
        if (done !== undefined && (done._tag === "Failure" || done.value.exitCode !== null))
          master = yield* start;
        yield* Fiber.join(master);
        return yield* openDoors(route.machine, (as) =>
          channel(remoteCollie(bridgeCommand([], client, as))),
        );
      }),
    collie: (args) =>
      Fiber.join(master).pipe(
        Effect.mapError(({ reason }) => reason),
        Effect.andThen(ran(channel(remoteCollie(args)))),
      ),
    sh: (script) =>
      Fiber.join(master).pipe(
        Effect.mapError(({ reason }) => reason),
        Effect.as(channel(`exec "\${SHELL:-/bin/sh}" -lc ${quoted(script)}`)),
      ),
    forward: (port) => {
      const spec = `${port}:127.0.0.1:${port}`;
      const asMaster = (verb: string) => [
        ssh,
        "-S",
        control,
        "-O",
        verb,
        "-L",
        spec,
        machine.target,
      ];
      return Effect.acquireRelease(
        Fiber.join(master).pipe(
          Effect.mapError(({ reason }) => reason),
          Effect.andThen(output(asMaster("forward"))),
        ),
        () => output(asMaster("cancel")).pipe(Effect.ignore),
      ).pipe(Effect.asVoid);
    },
  };
  return route;
});

/** Local, reached through a bridge it starts without SSH. */
export const localRoute = (collie: ReadonlyArray<string>, name: string): ShellRoute => {
  const machine = { profile: "local", name };
  return {
    machine,
    open: () => openDoors(machine, (as) => bridgeCommand(collie, name, as)),
    collie: (args) => ran([...collie, ...args]),
    sh: (script) => Effect.succeed([Bun.env.SHELL ?? "/bin/sh", "-lc", script]),
    // Its localhost is this computer's already.
    forward: () => Effect.void,
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

/** How long a route waits before it tries again, after so many tries in a row failed. */
const backoff = (failures: number) => Math.min(1000 * 2 ** failures, 60_000);

/** A route added, one removed, or one woken to try again now rather than after its backoff. */
export type RouteChange<D extends BoardSource = Doors> =
  | { readonly _tag: "Add"; readonly route: Route<D> }
  /** `done` once its stream has ended and its Machine is said to be removed. */
  | { readonly _tag: "Remove"; readonly profile: string; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Wake"; readonly profile: string };

/**
 * Every route's board, one stream per installation. Routes earlier in the list are
 * preferred, so a Machine reached two ways is shown through the first; a route that turns
 * out to reach a Machine already shown says so and ends, and its bridge with it. A route
 * that is not live says why, and tries again with backoff. `doors` holds each shown
 * Machine's door, by installation, for as long as its stream runs. A route added later is
 * preferred less than every route before it.
 */
export const flockStream = <D extends BoardSource>(
  routes: ReadonlyArray<Route<D>>,
  doors: Map<string, D>,
  version: string,
  changes: Stream.Stream<RouteChange<D>> = Stream.empty,
): Stream.Stream<FlockItem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const owners = yield* Ref.make(new Map<string, number>());
      // By each route's place in the order it was added.
      const displaced: Array<Deferred.Deferred<void>> = [];
      const removed: Array<Deferred.Deferred<void>> = [];
      const ended: Array<Deferred.Deferred<void>> = [];
      const wakes: Array<Queue.Queue<void>> = [];
      const places = new Map<string, number>();
      const routeAt: Array<Route<D>> = [];
      // Routes with nothing more to show: merged into another, or too new to read.
      const done = new Set<number>();
      // The installation each merged route reaches, by its place.
      const merged = new Map<number, string>();
      // Asked to upgrade at most once per connection. One that upgraded but did not move is
      // shown as it is; one that failed is asked again when it next connects.
      const upgrading = new Set<string>();
      const owns = (at: number, { machine, message }: MachineMessage) =>
        Effect.gen(function* () {
          const [owner, before] = yield* Ref.modify(owners, (now) => {
            const owner = now.get(machine.installation);
            const takes = message._tag === "Snapshot" && (owner === undefined || at < owner);
            const after = takes ? new Map(now).set(machine.installation, at) : now;
            return [[after.get(machine.installation), owner] as const, after] as const;
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
            const door = yield* route.open(waitingOnSso);
            // The build of a release older than Desktop, once its board is shown.
            const due = yield* Deferred.make<{
              readonly installation: string;
              readonly from: string;
            }>();
            let shown = false;
            const board = machineBoard(route.machine, door).pipe(
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
            return Stream.merge(board, upgrade, { haltStrategy: "left" });
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
          upgradeTo(route, version).pipe(
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
                    if (failure.state === "reopen") return afterFailures(0);
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
                if (owner === at) {
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

/** Why a host said no, in its own words, under the request it was asked as. */
const refusal =
  (request?: string) =>
  (
    error:
      | HostRefused
      | ProposalRefused
      | RequestConflict
      | RpcClientError.RpcClientError
      | Unsteered,
  ) =>
    new ActionFailed({
      request,
      reason:
        error._tag === "HostRefused" || error._tag === "RequestConflict"
          ? error.reason
          : error._tag === "ProposalRefused"
            ? error.detail
            : error.message,
    });

/** A steer the host carried no further, with what it said about it. */
interface Unsteered {
  readonly _tag: "Unsteered";
  readonly message: string;
}

/** One board action carried out on a Machine's host, and what it came to in a line. */
export const act = (door: Door, request: string, action: DesktopAction) => {
  const said = (() => {
    switch (action._tag) {
      case "Answer":
        return door
          .answer({ runId: action.runId, decision: action.decision, value: action.value, request })
          .pipe(Effect.as(`Answered ${action.runId}`));
      case "Control": {
        const verb = action.control === "stop" ? "Stopped" : action.set ? "Held" : "Released";
        return door
          .control({ runId: action.runId, control: action.control, set: action.set, request })
          .pipe(Effect.map((done) => done.detail || `${verb} ${action.runId}`));
      }
      case "Resume":
        return door
          .resume({ runId: action.runId, request })
          .pipe(Effect.map((done) => done.detail || `Resumed ${action.runId}`));
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
      case "FollowUp":
        return door
          .followUp({ runId: action.runId, text: action.text, request })
          .pipe(Effect.map((started) => `Started ${started.runId}`));
      case "Invoke":
        return door
          .invoke({ runId: action.runId, offer: action.offer, input: action.input, request })
          .pipe(Effect.map((started) => `Started ${started.runId}`));
      case "Start":
        return door
          .start({ project: action.project, id: action.id, input: {}, text: action.text, request })
          .pipe(Effect.map((started) => `Started ${started.runId}`));
    }
  })();
  return said.pipe(Effect.mapError(refusal(request)));
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

export const focusOn = (door: Door, request: string, runId: string) =>
  door.focus({ runId, request }).pipe(Effect.mapError(refusal(request)));

export const offersOn = (door: Door, runId: string) =>
  door.offers({ runId }).pipe(Effect.mapError(refusal()));

export const workflowsOn = (door: Door, project: string) =>
  door.workflows({ project }).pipe(Effect.mapError(refusal()));

export const runDetailOn = (door: Door, runId: string) =>
  door
    .runDetail({ runId, tail: true, pages: 1, refreshMr: false })
    .pipe(Stream.mapError(refusal()));

export const runFileOn = (door: Door, runId: string, ref: string, offset?: number) =>
  door.runFile({ runId, ref, offset }).pipe(Effect.mapError(refusal()));

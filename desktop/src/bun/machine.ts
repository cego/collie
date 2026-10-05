// Desktop's channel to a Machine's host: a bridge command started as `desktop`, whose
// output after the ready marker is the host's socket. Never Collie's own host client: over
// a channel that would start a host on this computer, or signal a pid that is not its own.

import { Deferred, Effect, Fiber, Layer, Ref, Schedule, Schema, type Scope, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { BRIDGE_READY, type BoardMessage, FrontDoorRpcs } from "../../../src/board-model";
import type { FlockItem, KnownMachine, Machine, MachineMessage } from "../shared/flock";

const children = new Set<Bun.Subprocess>();
export const endChildren = () => {
  for (const child of children) child.kill();
};

const spawned = <C extends Bun.Subprocess>(start: () => C) =>
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

/** The bridge `collie` runs for Desktop, which records Desktop's computer with what it does. */
export const bridgeCommand = (collie: ReadonlyArray<string>, client: string) => [
  ...collie,
  "bridge",
  "--as",
  "desktop",
  "--client",
  client,
];

/** Everything after the ready marker, whatever a login shell printed before it. */
const afterReady = (from: ReadableStream<Uint8Array>) => {
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
        const rest = seen.subarray(at + marker.length);
        if (rest.length > 0) out.enqueue(rest);
      },
    }),
  );
};

/** Starts the bridge and speaks `FrontDoorRpcs` over its stdio until the scope closes. */
export const openBridge = Effect.fn("Desktop.openBridge")(function* (
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  const child = yield* spawned(() =>
    Bun.spawn([...command], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
  );
  const socket = yield* Socket.fromTransformStream(
    Effect.succeed({
      readable: afterReady(child.stdout),
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
  return yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
});

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

const output = (command: ReadonlyArray<string>) =>
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
    if (code !== 0) return yield* Effect.fail(err.trim() || `${command.join(" ")} exited ${code}`);
    return out;
  });

/** A saved herdr machine, as `herdr machine list --json` lists it. */
const HerdrMachine = Schema.Struct({
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
});
export type HerdrMachine = typeof HerdrMachine.Type;
const HerdrMachines = Schema.fromJsonString(Schema.Array(HerdrMachine));

/**
 * The machines enabled in herdr. Asked here rather than through `src/herdr.ts`, which
 * would bring Collie's locks into Desktop; this is Desktop's only herdr call.
 */
export const herdrMachines = (herdr: string) =>
  output([herdr, "machine", "list", "--json"]).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(HerdrMachines)(json).pipe(Effect.mapError((e) => e.message)),
    ),
    Effect.map((machines) => machines.filter((machine) => machine.enabled)),
  );

/** One way to reach a Machine: what it is called, and how its bridge is opened. */
export interface Route {
  readonly machine: KnownMachine;
  readonly open: Effect.Effect<BoardSource, string, Scope.Scope>;
}

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** The bridge as the Machine's login shell runs it, as Local's is. */
const remoteBridge = (client: string) =>
  [
    `exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`,
    ...bridgeCommand([], client).map(quoted),
  ].join(" ");

/**
 * Opens a master to the machine and holds it until the scope closes. The user's SSH config
 * applies, and an SSO check is made once, here, rather than for every channel.
 */
const openMaster = Effect.fn("Desktop.openMaster")(function* (
  ssh: string,
  control: string,
  target: string,
) {
  const master = yield* spawned(() =>
    Bun.spawn([ssh, "-M", "-N", "-S", control, "-o", "ControlPersist=no", target], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const ended = Effect.promise(() =>
    Promise.all([master.exited, new Response(master.stderr).text()]),
  ).pipe(Effect.map(([code, err]) => err.trim() || `ssh to ${target} exited ${code}`));
  yield* output([ssh, "-S", control, "-O", "check", target]).pipe(
    Effect.retry({
      while: () => master.exitCode === null,
      schedule: Schedule.spaced("200 millis"),
    }),
    // Only a master that has ended stops the checks, and what it said is why.
    Effect.catch(() => ended.pipe(Effect.flatMap((reason) => Effect.fail(reason)))),
  );
});

/**
 * A route through a herdr machine. Its master opens now and lives as long as the scope;
 * each bridge is one more channel on it.
 */
export const remoteRoute = Effect.fn("Desktop.remoteRoute")(function* (
  ssh: string,
  control: string,
  machine: HerdrMachine,
  client: string,
) {
  const master = yield* openMaster(ssh, control, machine.target).pipe(Effect.forkScoped);
  const route: Route = {
    machine: { name: machine.label, target: machine.target },
    open: Fiber.join(master).pipe(
      Effect.andThen(
        // Never a login of its own: SSO is asked once, by the master.
        openBridge([
          ssh,
          "-S",
          control,
          "-o",
          "ControlMaster=no",
          "-T",
          machine.target,
          remoteBridge(client),
        ]),
      ),
    ),
  };
  return route;
});

/**
 * Every route's board, one stream per installation. Routes earlier in the list are
 * preferred, so a Machine reached two ways is shown through the first; a route that turns
 * out to reach a Machine already shown ends, and its bridge with it.
 */
export const flockStream = (routes: ReadonlyArray<Route>): Stream.Stream<FlockItem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const owners = yield* Ref.make(new Map<string, number>());
      const displaced = yield* Effect.forEach(routes, () => Deferred.make<void>());
      const owns = (at: number, { machine, message }: MachineMessage) =>
        Effect.gen(function* () {
          const [owner, before] = yield* Ref.modify(owners, (now) => {
            const owner = now.get(machine.installation);
            const takes = message._tag === "Snapshot" && (owner === undefined || at < owner);
            const after = takes ? new Map(now).set(machine.installation, at) : now;
            return [[after.get(machine.installation), owner] as const, after] as const;
          });
          const lost = before === undefined || before === owner ? undefined : displaced[before];
          if (lost !== undefined) yield* Deferred.succeed(lost, undefined);
          return owner === at;
        });
      return Stream.mergeAll(
        routes.map((route, at) =>
          Stream.unwrap(Effect.map(route.open, (door) => machineBoard(route.machine, door))).pipe(
            Stream.takeWhileEffect((item) => owns(at, item)),
            Stream.interruptWhen(Deferred.await(displaced[at]!)),
            Stream.catch((reason) =>
              Stream.succeed<FlockItem>({ _tag: "Lost", machine: route.machine, reason }),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      );
    }),
  );

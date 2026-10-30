// What a sweep would remove on each connected Machine, read on its own, and each chosen
// Machine's sweep. Kept here, not in the dialog, so a sweep outlives it; each one's end is also
// told in a toast.

import * as Arr from "effect/Array";
import { AsyncResult, Atom, AtomRegistry, injectRegistry, useAtomValue } from "@effect/atom-vue";
import { Clock, Effect, Exit } from "effect";
import { failureOf, newRequest } from "../../../src/shared/actions";
import {
  type CleanupRead,
  type CleanupSweep,
  type CleanupView,
  sweptToast,
} from "../../../src/shared/machine-cleanup";
import { FlockClient } from "../flock";

/** By profile; a Machine not in it was not live when the dialog read. */
const reads = ref<ReadonlyMap<string, CleanupRead>>(new Map());
/** Null chooses every Machine that can be. */
const chosen = ref<ReadonlySet<string> | null>(null);
/** By profile, from the first press until the dialog reads again. */
const sweeps = ref<ReadonlyMap<string, CleanupSweep>>(new Map());
/** By profile: the latest ask, the only one whose answer is kept. */
const asks = new Map<string, number>();
let asked = 0;
const stillAtom = Atom.make(Effect.succeed(0));

export const useCleanup = () => {
  const toast = useToast();
  const registry = injectRegistry();
  // Not through a mutation atom: a new call to one interrupts the call before it.
  const call = <A, E>(effect: Effect.Effect<A, E, FlockClient>) =>
    Effect.runPromiseExit(
      AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provideContext(context))),
      ),
    );
  const reading = computed(() =>
    Arr.some([...reads.value.values()], ({ state }) => state === "reading"),
  );
  const clock = useAtomValue(() => (reading.value ? secondsAtom : stillAtom));
  const setRead = (profile: string, read: CleanupRead) => {
    reads.value = new Map(reads.value).set(profile, read);
  };
  const readOne = (profile: string) => {
    const ask = ++asked;
    asks.set(profile, ask);
    setRead(profile, { state: "reading", since: Effect.runSync(Clock.currentTimeMillis) });
    return call(FlockClient.use((client) => client("cleanup", { profile }))).then((exit) => {
      if (asks.get(profile) !== ask) return;
      setRead(
        profile,
        Exit.isSuccess(exit)
          ? { state: "listed", ...exit.value }
          : { state: "failed", problem: failureOf(exit.cause).reason },
      );
    });
  };
  const refresh = (live: ReadonlyArray<string>) => {
    asks.clear();
    reads.value = new Map();
    chosen.value = null;
    sweeps.value = new Map();
    return Promise.all(Arr.map(live, readOne));
  };
  const running = () => Arr.some([...sweeps.value.values()], ({ state }) => state === "running");
  const set = (profile: string, sweep: CleanupSweep) => {
    sweeps.value = new Map(sweeps.value).set(profile, sweep);
  };
  const send = (
    { profile, name, installation }: { profile: string; name: string; installation: string },
    request: string,
  ) => {
    set(profile, { state: "running", request });
    return call(
      FlockClient.use((client) => client("sweep", { installation, machine: name, request })),
    ).then((exit) => {
      const ended: Exclude<CleanupSweep, { state: "running" }> = Exit.isSuccess(exit)
        ? { state: "done", report: exit.value }
        : { state: "failed", request, reason: failureOf(exit.cause).reason };
      set(profile, ended);
      toast.add(sweptToast(name, ended));
    });
  };
  const listed = ({ profile, name }: { profile: string; name: string }) => {
    const read = reads.value.get(profile);
    return read?.state === "listed" ? [{ profile, name, installation: read.installation }] : [];
  };
  return {
    reads: readonly(reads),
    now: computed(() => AsyncResult.getOrElse(clock.value, () => 0)),
    chosen,
    sweeps: readonly(sweeps),
    /** Shows the sweeps while any runs; otherwise reads each of the `live` profiles afresh. */
    opened: (live: ReadonlyArray<string>) => (running() ? Promise.resolve() : refresh(live)),
    readAgain: readOne,
    clean: (view: CleanupView) =>
      Promise.all(
        Arr.map(
          Arr.flatMap(
            Arr.filter(view.rows, (row) => row.chosen),
            listed,
          ),
          (machine) => send(machine, newRequest()),
        ),
      ),
    tryAgain: (row: { profile: string; name: string }) => {
      const failed = sweeps.value.get(row.profile);
      const [machine] = listed(row);
      return failed?.state === "failed" && machine !== undefined
        ? send(machine, failed.request)
        : Promise.resolve();
    },
  };
};

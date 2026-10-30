import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { useAtomSet } from "@effect/atom-vue";
import { Cause, Exit } from "effect";
import { connectionCards, type MachineConnections } from "../../../src/shared/connections";
import { FlockClient } from "../flock";

const connectionsAtom = FlockClient.mutation("connectionReadings");

export const useConnections = () => {
  const ask = useAtomSet(() => connectionsAtom, { mode: "promiseExit" });
  const { rows, now } = useFlock();
  const readings = shallowRef<ReadonlyArray<MachineConnections>>([]);
  const trouble = ref<string | null>(null);
  const reading = ref(false);
  let requested = 0;
  let readAt = 0;
  const refresh = () => {
    const mine = ++requested;
    reading.value = true;
    readAt = now.value;
    return ask({ payload: undefined }).then((exit) => {
      if (mine !== requested) return;
      reading.value = false;
      if (Exit.isSuccess(exit)) {
        readings.value = exit.value;
        trouble.value = null;
      } else trouble.value = Cause.pretty(exit.cause);
    });
  };
  watch(
    () =>
      Arr.join(
        Arr.map(rows.value, (row) => `${row.profile}:${row.state}`),
        ",",
      ),
    () => void refresh(),
    { immediate: true },
  );
  watch(now, (at) => {
    if (!reading.value && at - readAt >= 60_000) void refresh();
  });
  const machines = computed(() =>
    Arr.map(rows.value, (row) => {
      const held = Option.getOrUndefined(
        Arr.findFirst(readings.value, (read) => read.profile === row.profile),
      );
      return {
        profile: row.profile,
        name: row.name,
        connections: held?.connections ?? [],
        workflows: held?.workflows ?? [],
        problem:
          row.state !== "live"
            ? (row.reason ?? "Out of reach")
            : (held?.problem ?? (held === undefined ? "Not read yet" : null)),
      };
    }),
  );
  const workflows = computed(() => [
    ...new Map(
      Arr.map(
        Arr.flatMap(machines.value, (machine) => machine.workflows),
        (workflow) => [workflow.id, workflow],
      ),
    ).values(),
  ]);
  return {
    cards: computed(() => connectionCards(machines.value)),
    workflows,
    trouble: readonly(trouble),
    reading: readonly(reading),
    refresh,
  };
};

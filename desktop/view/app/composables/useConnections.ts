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
    () => rows.value.map((row) => `${row.profile}:${row.state}`).join(","),
    () => void refresh(),
    { immediate: true },
  );
  watch(now, (at) => {
    if (!reading.value && at - readAt >= 60_000) void refresh();
  });
  const machines = computed(() =>
    rows.value.map((row) => {
      const held = readings.value.find((read) => read.profile === row.profile);
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
      machines.value
        .flatMap((machine) => machine.workflows)
        .map((workflow) => [workflow.id, workflow]),
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

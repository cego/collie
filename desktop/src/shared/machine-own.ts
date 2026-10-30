import * as Arr from "effect/Array";
import { DateTime, Schema } from "effect";
import { MachineOwn } from "../../../src/board-model";
import type { MachineRow } from "./flock";
import { whenOf } from "./flow";
import type { Said } from "./flock-settings";

export const OwnReading = Schema.Struct({
  values: Schema.NullOr(MachineOwn),
  at: Schema.Finite,
  problem: Schema.NullOr(Schema.String),
  unsupported: Schema.Boolean,
});
export type OwnReading = typeof OwnReading.Type;

export const keepOwn = (reading: OwnReading, before?: OwnReading): OwnReading =>
  reading.values === null && !reading.unsupported && before?.values != null
    ? { ...reading, values: before.values, at: before.at }
    : reading;

export const machineOwnRows = (
  machines: ReadonlyArray<MachineRow>,
  readings: ReadonlyMap<string, OwnReading>,
  now: number,
  timeZone?: string,
) =>
  Arr.map(machines, (machine) => {
    const read = readings.get(machine.profile);
    const values = read?.values;
    const synced = machine.settings;
    const sync: Said =
      machine.state !== "live"
        ? { said: machine.state === "connecting" ? "Connecting" : "Out of reach", tone: "warn" }
        : synced === null
          ? { said: "Not read yet", tone: "warn" }
          : synced.failed === null
            ? { said: "In sync", tone: "ok" }
            : { said: "Behind", tone: "warn" };
    const stale = machine.state !== "live" || read?.problem != null;
    const detail = read?.unsupported
      ? `Not known: ${machine.name} runs Collie ${machine.build ?? "(version not known)"}`
      : values != null && stale
        ? `Last read ${whenOf(DateTime.formatIso(DateTime.makeUnsafe(read!.at)), now, timeZone)}${read?.problem == null ? "" : ` · ${read.problem}`}`
        : (read?.problem ?? synced?.failed ?? (values == null ? "Not read yet" : null));
    return {
      profile: machine.profile,
      name: machine.name,
      where: machine.target ?? "This computer",
      sync,
      detail,
      at: values == null ? null : read!.at,
      readAt: values == null ? null : DateTime.formatIso(DateTime.makeUnsafe(read!.at)),
      projectsRoot: values == null ? null : (values.projectsRoot ?? "Not set"),
      chatHarness: values == null ? null : (values.chatHarness ?? "Not set"),
      harnesses: values?.harnesses ?? [],
      remembered: values?.remembered ?? [],
    };
  });
export type MachineOwnRow = ReturnType<typeof machineOwnRows>[number];

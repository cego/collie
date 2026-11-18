import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import { Data, Effect } from "effect";
import { atLeast, installedVersion } from "./compactors";

export type Capability = "now" | "interrupt" | "ack" | "attribution";

export interface CapabilityRecord {
  readonly status: "proven" | "unproven";
  readonly version_floor: string;
  readonly tested_at: string | null;
  readonly interrupt_key?: ReadonlyArray<string>;
}

export const CAPABILITIES = {
  claude: {
    now: { status: "proven", version_floor: "2.1.263", tested_at: "2026-09-11" },
    interrupt: {
      status: "proven",
      version_floor: "2.1.263",
      tested_at: "2026-09-11",
      interrupt_key: ["Escape"],
    },
    ack: { status: "proven", version_floor: "2.1.263", tested_at: "2026-09-11" },
    attribution: { status: "unproven", version_floor: "2.1.263", tested_at: null },
  },
  codex: {
    now: { status: "unproven", version_floor: "0.153.4", tested_at: null },
    interrupt: {
      status: "unproven",
      version_floor: "0.153.4",
      tested_at: null,
      interrupt_key: ["Escape"],
    },
    ack: { status: "unproven", version_floor: "0.153.4", tested_at: null },
    attribution: { status: "unproven", version_floor: "0.153.4", tested_at: null },
  },
  opencode: {
    now: { status: "unproven", version_floor: "1.18.9", tested_at: null },
    interrupt: {
      status: "unproven",
      version_floor: "1.18.9",
      tested_at: null,
      interrupt_key: ["Escape"],
    },
    ack: { status: "unproven", version_floor: "1.18.9", tested_at: null },
    attribution: { status: "unproven", version_floor: "1.18.9", tested_at: null },
  },
  pi: {
    now: { status: "unproven", version_floor: "0.85.1", tested_at: null },
    interrupt: {
      status: "proven",
      version_floor: "0.85.1",
      tested_at: "2026-09-11",
      interrupt_key: ["Escape"],
    },
    ack: { status: "unproven", version_floor: "0.85.1", tested_at: null },
    attribution: { status: "unproven", version_floor: "0.85.1", tested_at: null },
  },
} satisfies Record<string, Record<Capability, CapabilityRecord>>;

function rowFor(harness: string) {
  // WARNING: the check establishes that `harness` is one of the table's own keys.
  const returned: Record<Capability, CapabilityRecord> | undefined = Arr.some(
    Rec.keys(CAPABILITIES),
    (key) => key === harness,
  )
    ? CAPABILITIES[harness as keyof typeof CAPABILITIES]
    : undefined;
  return returned;
}

export function capabilitiesOf(harness: string) {
  return rowFor(harness);
}

export function needed(mode: "boundary" | "now" | "interrupt") {
  return mode === "boundary" ? null : mode;
}

export class CapabilityUnproven extends Data.TaggedError("CapabilityUnproven")<{
  reason: string;
}> {}

export const gate = Effect.fn("SteeringCaps.gate")(function* (
  harness: string,
  mode: "boundary" | "now" | "interrupt",
) {
  const capability = needed(mode);
  if (capability === null) return;
  const record = rowFor(harness)?.[capability];
  if (!record || record.status !== "proven")
    return yield* new CapabilityUnproven({
      reason: `capability_unproven:${harness}:${mode}`,
    });
  const installed = yield* installedVersion(harness);
  if (installed === null || !atLeast(installed, record.version_floor))
    return yield* new CapabilityUnproven({
      reason: `capability_unproven:${harness}:${mode} (installed ${installed ?? "unknown"}, tested against ${record.version_floor})`,
    });
});

export function interruptKeys(harness: string) {
  return rowFor(harness)?.interrupt.interrupt_key ?? null;
}

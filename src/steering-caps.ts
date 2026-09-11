// What each harness has been *shown* to do about a delivery, and what it has not.
//
// herdr types text into a pane and returns. That says the keystrokes went somewhere; it
// does not say the harness took them as a turn, understood them, or stopped what it was
// doing. Every one of those is a separate fact, and a different fact per harness — so
// they are recorded here from live tests rather than reasoned about from documentation.
//
// The table starts entirely `unproven` and moves only when `tools/steering-live.ts`
// records a pass in `CAPABILITIES.md`. Nothing here may be flipped to `proven` because a
// harness's `--help` mentions a flag: help text is a claim, not a result.

import { Data, Effect } from "effect";
import { atLeast, installedVersion } from "./compactors";

/** The four things a delivery may need of a harness. `boundary` needs none of them. */
export type Capability = "now" | "interrupt" | "ack" | "attribution";

export interface CapabilityRecord {
  readonly status: "proven" | "unproven";
  /** The release the live test ran against; an older install is not covered by it. */
  readonly version_floor: string;
  /** When it was last shown, or null for a capability nobody has tested. */
  readonly tested_at: string | null;
  /** For `interrupt`: the keys this harness takes as "stop what you are doing". */
  readonly interrupt_key?: ReadonlyArray<string>;
}

/**
 * The recorded state of every harness × capability. Kept beside `CAPABILITIES.md`, which
 * carries the evidence; this is the machine-readable half and a test asserts the two say
 * the same thing.
 */
export const CAPABILITIES = {
  claude: {
    // Recorded 2026-09-11 against claude 2.1.268 under herdr 0.9.0, by
    // `tools/steering-live.ts`: a working agent took the delivery and wrote its ack
    // within ten seconds; Escape then a delivery left `working` and was acknowledged.
    // The rows are in the release's CAPABILITIES.md with the ack files and ledger.
    now: { status: "proven", version_floor: "2.1.263", tested_at: "2026-09-11" },
    interrupt: {
      status: "proven",
      version_floor: "2.1.263",
      tested_at: "2026-09-11",
      interrupt_key: ["Escape"],
    },
    ack: { status: "proven", version_floor: "2.1.263", tested_at: "2026-09-11" },
    // Needs a human typing into a Collie-launched agent's pane: not something an agent
    // pressing keys can stand in for, so it stays unproven until an operator records it.
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
    // No hook surface Collie can install: an external prompt is invisible to it.
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
    // Recorded 2026-09-11 against pi 0.85.1 under herdr 0.9.0: Escape ended the running
    // turn and the delivery after it was acknowledged. `now` is not proven — a prompt
    // typed while pi works sits in its editor until that turn ends — so the ack it
    // wrote arrived only after the interrupt, and `ack` stays unproven with it.
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

/** One harness's row, or none: a harness nobody has tested is not in the table. */
function rowFor(harness: string): Record<Capability, CapabilityRecord> | undefined {
  // SAFETY: `hasOwn` has just established that `harness` is one of the table's own keys.
  return Object.hasOwn(CAPABILITIES, harness)
    ? CAPABILITIES[harness as keyof typeof CAPABILITIES]
    : undefined;
}

/** One harness's recorded row, for a caller that has a harness name and not a literal. */
export function capabilitiesOf(harness: string) {
  return rowFor(harness);
}

/** The capability a delivery mode needs. `boundary` is the next prompt; it needs none. */
export function needed(mode: "boundary" | "now" | "interrupt"): Capability | null {
  return mode === "boundary" ? null : mode;
}

export class CapabilityUnproven extends Data.TaggedError("CapabilityUnproven")<{
  reason: string;
}> {}

/**
 * Whether this harness may be sent to this way. Fails closed in every uncertain case: an
 * unknown harness, an untested capability, or an install older than the release the test
 * ran against. The alternative — sending anyway and hoping — produces a delivery nobody
 * can say the fate of, which is the state this whole design exists to avoid.
 */
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

/** The keys this harness takes as an interrupt, or none — in which case it cannot be. */
export function interruptKeys(harness: string): ReadonlyArray<string> | null {
  return rowFor(harness)?.interrupt.interrupt_key ?? null;
}

import { Effect, Schema } from "effect";
import { FlowState, RequestedBy } from "./board-model";
import { appendJournal, readJournal } from "./journal";

export const RunLinkNotice = Schema.Struct({
  requestedBy: RequestedBy,
  run: Schema.String,
  workflow: Schema.String,
  machine: RequestedBy.fields.machine,
  phase: Schema.Literals(["admitted", "settled"]),
  state: FlowState,
  said: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type RunLinkNotice = typeof RunLinkNotice.Type;

const LinkedRun = Schema.Struct({ ...RunLinkNotice.fields, step: Schema.NullOr(Schema.String) });
const LinkedRunJson = Schema.fromJsonString(LinkedRun);

export const readRunLinks = Effect.fn("RunLinks.read")(function* (runDir: string) {
  const latest = new Map<string, typeof LinkedRun.Type>();
  for (const notice of yield* readJournal(`${runDir}/links.jsonl`, LinkedRunJson)) {
    const key = `${notice.machine.installation}/${notice.run}`;
    if (latest.get(key)?.phase === "settled" && notice.phase === "admitted") continue;
    latest.set(key, notice);
  }
  return [...latest.values()];
});

export const recordRunLink = (runDir: string, notice: typeof LinkedRun.Type) =>
  appendJournal(`${runDir}/links.jsonl`, LinkedRunJson, notice);

export const LinkDelivery = Schema.Struct({
  phase: RunLinkNotice.fields.phase,
  state: Schema.Literals(["delivered", "undelivered"]),
  at: Schema.String,
  note: Schema.String,
});
const LinkDeliveryJson = Schema.fromJsonString(LinkDelivery);
export const readLinkDeliveries = (runDir: string) =>
  readJournal(`${runDir}/link-deliveries.jsonl`, LinkDeliveryJson);
export const recordLinkDelivery = (runDir: string, delivery: typeof LinkDelivery.Type) =>
  appendJournal(`${runDir}/link-deliveries.jsonl`, LinkDeliveryJson, delivery);

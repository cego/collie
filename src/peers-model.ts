import { Effect, Schema } from "effect";
import { FrontDoor } from "./board-model";

export const HerdrMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
});
export type HerdrMachine = typeof HerdrMachine.Type;

export const PEER_PORT = 47_217;

export const backoff = (failures: number) => Math.min(1000 * 2 ** failures, 60_000);

export const Dials = Schema.Literals(["out", "in"]);
export type Dials = typeof Dials.Type;

export const Peer = Schema.Struct({
  installation: Schema.String,
  name: Schema.String,
  dials: Dials,
  url: Schema.optionalKey(Schema.String),
  certificate: Schema.optionalKey(Schema.String),
  secret: Schema.String,
});
export type Peer = typeof Peer.Type;
export const PeersFile = Schema.fromJsonString(Schema.Array(Peer), { space: 2 });

export const Invited = Schema.Struct({
  installation: Schema.String,
  port: Schema.Int,
  certificate: Schema.String,
  secret: Schema.String,
  dials: Schema.optionalKey(Dials),
});
export type Invited = typeof Invited.Type;

export const AgentAddress = Schema.Struct({ run: Schema.String, agent: Schema.String });
export type AgentAddress = typeof AgentAddress.Type;
export const AgentAddressJson = Schema.fromJsonString(AgentAddress);

export const RelayHeader = Schema.Struct({
  as: FrontDoor,
  sender: Schema.optionalKey(AgentAddress),
  client: Schema.String,
  stamp: Schema.optionalKey(Schema.String),
});
export type RelayHeader = typeof RelayHeader.Type;
export const RelayHeaderJson = Schema.fromJsonString(RelayHeader);

export const PeerState = Schema.Literals(["live", "connecting", "away"]);
export type PeerState = typeof PeerState.Type;

export const Waits = Schema.Literal("ssh_connection");

export const Transport = Schema.Literals(["direct", "ssh"]);

const orNull = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));

export const PeerView = Schema.Struct({
  installation: Schema.String,
  name: Schema.String,
  dials: Dials,
  url: Schema.NullOr(Schema.String),
  state: PeerState,
  build: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  since: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  transport: orNull(Transport),
  direct: orNull(Schema.String),
  ssh: orNull(Schema.String),
  connection: orNull(Schema.Boolean),
  waits: orNull(Waits),
});
export type PeerView = typeof PeerView.Type;

export class MachineUnreachable extends Schema.TaggedError<
  MachineUnreachable,
  { readonly brand: unique symbol }
>()("MachineUnreachable", {
  machine: Schema.String,
  seen: Schema.String,
  direct: Schema.optionalKey(Schema.String),
  ssh: Schema.optionalKey(Schema.String),
  waits: Schema.optionalKey(Waits),
}) {}

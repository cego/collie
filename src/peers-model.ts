// What two Machines and their front doors agree on about a pairing (ADR-0057): herdr's list
// of machines, the pairing each side keeps, and the line that opens a relay. Effect alone,
// so Desktop decodes the same schemas.

import { Effect, Schema } from "effect";
import { FrontDoor } from "./board-model";

/** A saved herdr machine, as `herdr machine list --json` lists it. */
export const HerdrMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  session: Schema.String,
  enabled: Schema.Boolean,
});
export type HerdrMachine = typeof HerdrMachine.Type;
export const HerdrMachines = Schema.fromJsonString(Schema.Array(HerdrMachine));

/** The port a Machine a peer dials listens on. */
export const PEER_PORT = 47217;

/** How long to wait after `failures` failures in a row: 1 s, doubling, at most a minute. */
export const backoff = (failures: number) => Math.min(1000 * 2 ** failures, 60_000);

/** Which side opens the connection: this Machine dials `out` to a peer that listens. */
export const Dials = Schema.Literals(["out", "in"]);
export type Dials = typeof Dials.Type;

/** One pairing, as each side keeps it in `peers.json`. */
export const Peer = Schema.Struct({
  installation: Schema.String,
  name: Schema.String,
  dials: Dials,
  /** Where a peer that listens is dialled, `wss://<host>:<port>`. */
  url: Schema.optionalKey(Schema.String),
  /** The listener's certificate, the only one trusted for it. */
  certificate: Schema.optionalKey(Schema.String),
  secret: Schema.String,
});
export type Peer = typeof Peer.Type;
export const PeersFile = Schema.fromJsonString(Schema.Array(Peer), { space: 2 });

/** What a Machine that is invited answers with. */
export const Invited = Schema.Struct({
  installation: Schema.String,
  port: Schema.Int,
  certificate: Schema.String,
  secret: Schema.String,
  /** The asker's direction when the listener already has a pairing to it. */
  dials: Schema.optionalKey(Dials),
});
export type Invited = typeof Invited.Type;

/** The first line on a relay socket: the front door asking, and the computer it runs on. */
export const AgentAddress = Schema.Struct({ run: Schema.String, agent: Schema.String });
export type AgentAddress = typeof AgentAddress.Type;
export const AgentAddressJson = Schema.fromJsonString(AgentAddress);

export const RelayHeader = Schema.Struct({
  as: FrontDoor,
  sender: Schema.optionalKey(AgentAddress),
  client: Schema.String,
  /** The relay's own host's, which a front door cannot know: what lets `as` be `host`. */
  stamp: Schema.optionalKey(Schema.String),
});
export type RelayHeader = typeof RelayHeader.Type;
export const RelayHeaderJson = Schema.fromJsonString(RelayHeader);

/** Whether a peer answers now. */
export const PeerState = Schema.Literals(["live", "connecting", "away"]);
export type PeerState = typeof PeerState.Type;

/** What a link not up waits on before it can be: an SSH connection a front door opens. */
export const Waits = Schema.Literal("ssh_connection");

/** A link's way to its peer: to the peer's port, or through the Machine's SSH connection. */
export const Transport = Schema.Literals(["direct", "ssh"]);

/** A field an older Machine's list does not have. */
const orNull = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));

/** A pairing as `collie machine list` shows it: never its secret. */
export const PeerView = Schema.Struct({
  installation: Schema.String,
  name: Schema.String,
  dials: Dials,
  url: Schema.NullOr(Schema.String),
  state: PeerState,
  build: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Since when it has been away, or what the last try saw. */
  since: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  /** The way a live link went. */
  transport: orNull(Transport),
  /** What the direct way saw when it last failed; a live `ssh` link keeps it. */
  direct: orNull(Schema.String),
  /** What the SSH way saw when it was last tried and failed. */
  ssh: orNull(Schema.String),
  /** For a peer this Machine dials, whether this computer holds an SSH connection to it. */
  connection: orNull(Schema.Boolean),
  waits: orNull(Waits),
});
export type PeerView = typeof PeerView.Type;

/**
 * A call to a Machine that did not answer within its bound, naming it and what was seen:
 * no control link, a refused connection, or no dial-back. A peer this Machine dials also
 * says what each way to it saw.
 */
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

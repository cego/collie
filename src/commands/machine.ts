// `collie machine`: the Machines this one is paired with (ADR-0057). Pairing happens by
// itself on first reach and forgetting follows herdr's list, so `list` and `connect`, which
// opens the SSH connection a blocked link rides, are what a human has a use for; `invite`
// is what pairing runs on the other Machine over SSH.

import * as Arr from "effect/Array";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { inviteFrom, machineConnect, machineList } from "../lifecycle";
import type { PeerView } from "../peers-model";
import { BUILD } from "../host";
import { answering } from "./shared";

/** How a link stands, and which way it went or what each way saw. */
const standing = (peer: PeerView) => {
  const state =
    peer.state === "away" && peer.since !== null ? `away since ${peer.since}` : peer.state;
  if (peer.state === "live")
    return [
      state,
      ...(peer.transport === "ssh"
        ? [`ssh${peer.direct === null ? "" : ` (direct: ${peer.direct})`}`]
        : peer.transport === "direct"
          ? ["direct"]
          : []),
      ...(peer.failure === null ? [] : [peer.failure]),
    ];
  const ways = [
    ...(peer.direct === null ? [] : [`direct: ${peer.direct}`]),
    ...(peer.ssh === null ? [] : [`ssh: ${peer.ssh}`]),
  ];
  return [
    state,
    ...(ways.length > 0 ? [Arr.join(ways, "; ")] : peer.failure === null ? [] : [peer.failure]),
  ];
};

const list = Command.make("list", {}, () =>
  answering((env) =>
    machineList(env).pipe(
      Effect.map((read) => {
        if (!read.ok) return read;
        const peers = read.value;
        return {
          ok: true as const,
          data: { build: BUILD, machines: peers },
          human:
            `This Machine: collie ${BUILD}\n` +
            (peers.length === 0
              ? "No Machine is paired with this one."
              : Arr.join(
                  Arr.map(peers, (peer) =>
                    Arr.join(
                      [
                        peer.name,
                        peer.dials === "out" ? "dialled from here" : "dials in",
                        peer.build === null ? "build not read" : `collie ${peer.build}`,
                        ...standing(peer),
                      ],
                      "\t",
                    ),
                  ),
                  "\n",
                )),
        };
      }),
    ),
  ),
).pipe(Command.withDescription("The Machines paired with this one, and whether each is live"));

const connect = Command.make(
  "connect",
  { name: Argument.String("name").pipe(Argument.withDescription("herdr's name for the Machine")) },
  ({ name }) =>
    answering((env) =>
      machineConnect(env, name, (text) => Effect.sync(() => void process.stderr.write(text))).pipe(
        Effect.map((read) =>
          read.ok
            ? {
                ok: true as const,
                data: read.value,
                human: read.value.opened
                  ? `Opened an SSH connection to ${name} at ${read.value.path}.`
                  : `${name} already has an SSH connection at ${read.value.path}.`,
              }
            : read,
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Open this computer's SSH connection to a Machine, which a link its network blocks rides",
  ),
);

const invite = Command.make(
  "invite",
  {
    for: Flag.String("for").pipe(Flag.withDescription("The installation asking to pair")),
    name: Flag.String("name").pipe(Flag.withDescription("What this Machine calls the asker")),
    address: Flag.String("address").pipe(
      Flag.withDescription("The address the asker dials this Machine at"),
      Flag.optional,
    ),
  },
  (flags) =>
    answering((env) =>
      inviteFrom(env, {
        installation: flags.for,
        name: flags.name,
        address: Option.getOrNull(flags.address),
      }).pipe(
        Effect.map((read) =>
          read.ok
            ? {
                ok: true as const,
                data: read.value,
                human: `Paired with ${flags.name}; it dials port ${read.value.port}.`,
              }
            : read,
        ),
      ),
    ),
).pipe(
  Command.withDescription("Plumbing: pair with the installation asking, as pairing runs over SSH"),
);

export const machine = Command.make("machine").pipe(
  Command.withDescription("The Machines paired with this one"),
  Command.withSubcommands([list, connect, invite]),
);

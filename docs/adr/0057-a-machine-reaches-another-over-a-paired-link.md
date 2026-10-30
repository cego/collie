# A Machine reaches another over a paired link

Amended by [ADR-draft-collie-runs-its-agents-in-herdr-core](draft-collie-runs-its-agents-in-herdr-core.md): core's machine list replaces herdr's as the list of Machines.

**Status: accepted.** Drafted by the architecture step of run-372b88e4, and built with it.
Amended by [ADR-draft-a-blocked-link-rides-the-machines-ssh-connection](draft-a-blocked-link-rides-the-machines-ssh-connection.md):
a link the network refuses rides the Machine's SSH connection.

It amends four earlier ADRs:

- [ADR-0015](0015-one-local-host-owns-a-state-directory.md) D3 ("nothing listening off
  this machine");
- [ADR-0038](0038-the-host-builds-and-serves-the-board.md) D2 ("another computer reaches
  it through a bridge on the Machine itself");
- [ADR-0039](0039-every-operation-records-who-asked.md), whose `from` was `desktop`'s only;
- [ADR-0043](0043-a-shared-setting-is-its-latest-edit.md) D3, under which only Desktop
  kept the Flock's settings.

A developer's Flock is their laptop and their VM. Each host reaches the other directly,
in both directions, with or without Desktop open. An agent, a Schedule, the CLI and
Desktop all reach the other Machine the same way: through a unix socket the local host
keeps for it.

## What was true before

- **A host listened only on `host.sock`.** Another computer reached it only through
  `collie bridge` over SSH. Desktop was the only program that did so, which made it the
  only thing that crossed Machines:
  - Flock settings;
  - starting a Run on another Machine;
  - carried files;
  - credentials;
  - upgrades.
- **With Desktop closed, the Flock was disconnected.** A Schedule on the VM could not
  start a laptop Run, and a setting edited on one Machine stayed there.
- **Agents could not reach the other Machine at all,** even with Desktop open.
- **Every SSH login cost an SSO approval.** On a cego VM, sshd's `AuthorizedKeysCommand`
  asks `sso.cego.dk` for an approval at every new login. Desktop opened a master at
  every start and after every sleep, so each of those cost one.

## Decision

**D1. Point-to-point pairs.**

- A Machine the other can open a connection to is _dialable_, and it listens.
- A Machine the other cannot reach, such as a laptop behind a VPN, keeps a control link
  open to its dialable peer. It is reached by dial-back over that link.
- There is no hub role and no relaying through a third Machine. With one laptop and one
  VM, the always-on VM is the hub. A third Machine pairs with each of the others.

**D2. Adding a Machine to herdr pairs it. Pairing is never a step of its own.**

- **What adding a Machine already gives.** herdr's list of machines is the list of
  Machines (`herdr machine list`, read through `src/herdr.ts`). Adding one gives Collie a
  channel it can already trust: the SSH target, and the SSO approval its first login asks
  for. Pairing needs nothing more than that, so Collie pairs by itself the first time it
  reaches a listed Machine that it has no pairing for:
  - Desktop pairs as it connects, over the SSH master the human already approved.
  - Without Desktop, the first `collie --machine <label>` pairs, then runs. Its SSH login
    is the one approval, said where the command was run.
- **How a pairing is made.** Collie runs `collie machine invite` on the target over that
  SSH. The target answers with:
  - its installation id;
  - its port, which is fixed at 47217;
  - its self-signed certificate, made once with `openssl`;
  - a secret minted for the asking installation.
- **What the pairing records.** The address dialled is the SSH target's own `HostName`.
  The name is herdr's label for the machine, which is the name Desktop shows. Each side
  keeps the pairing in `peers.json` in its state directory, mode 0600.
- **Removing a Machine forgets it.** When herdr no longer lists a peer, the dialling host
  drops the pairing as the link next comes up, and tells the other side, which drops it
  too.
- **Where pairing can't run.** A host's own jobs, such as a Schedule, never start an SSH
  login, because there is no one to approve it. One that reaches an unpaired Machine is
  refused, naming it as not paired yet.

**D3. TLS pinned to the peer's certificate, with the secret as bearer.**

- **The certificate.** The listener's certificate is the only one the dialler trusts, and
  the secret goes only over that TLS.
  The original self-signed certificate remains the sole CA when a new address needs
  another listener certificate. That certificate is signed by the original pin and
  retains earlier address names, so existing pairings keep working with hostname verification.
- **The listener.** A Machine with no peer that dials it does not listen at all.
- **Why TLS.** The listener is reachable from the office network. In clear text, the
  secret would let anyone on that path run agents as the user. That is the concrete harm
  this guards against, and it binds humans and agents alike.

**D4. A channel is declared by the host it ends at.**

- **Every logical channel is its own connection.** That covers a direct one to the
  listener, or a dial-back.
- **The declaration.** The host the channel ends at declares the channel on a fresh
  `host.sock` connection, then pipes bytes. This is how `collie bridge` hands over its
  stdio, and they share one function.
- **What the declaration names:**
  - The front door is the one the far end named when it opened the channel.
  - `from.machine` is the installation the credential belongs to, with its name.
- **The far end can't change it.** It cannot name another Machine, and it can't
  redeclare another front door ([ADR-0039](0039-every-operation-records-who-asked.md)
  D2).
- **No new RPC protocol.** Calls go both ways because each direction is its own
  connection, so nothing is multiplexed and no RPC is rebuilt on top of RPC.

**D5. One relay socket per peer.**

- **The socket.** The host keeps `peers/<name>.sock` in its state directory for each peer.
  It speaks exactly what `host.sock` speaks.
- **What a connection to it does.** Toward a dialable peer, it is piped to a fresh TLS
  WebSocket. Toward an undialable peer, it is piped to a dial-back asked for over that
  peer's control link.
- **Only a header is new.** The first line on the relay names the front door and the
  client, as `collie bridge --as … --client …` does. Everything after it is the host
  protocol.
- **Who uses it:**
  - **A command that names a Run** goes to the Run wherever it is. It asks this host
    first, then each live peer, because a Run id names one Run and saying the Machine
    again would be a second action.
  - **`collie --machine <name> …`** is only for a command that names no Run: the board, a
    start, a list.
  - **`collie bridge --machine <name>`** gives Desktop the same thing.
  - **The host's own jobs** that reach a peer.

**D6. The whole host protocol, as the bridge serves it.**

- **Everything is served.** A paired installation is the same user. `FrontDoorRpcs`
  already has `start` and `writeFile`, so withholding `HostRpcs` would protect nothing and
  would break the CLI's run commands.
- **A shell, so the link carries what SSH carried.** `FrontDoorRpcs` gains `shell`: a
  script, and optionally stdin, run in the Machine's login shell, with the code and output
  returned within a bound. Desktop's upgrades, doctor and credentials go through it on a
  paired Machine, so no SSO approval is asked for something the link already
  authenticated.
- **The newer side wins across Machines too**
  ([ADR-0015](0015-one-local-host-owns-a-state-directory.md) D5).
  - When a link comes up between two releases, the newer host upgrades the older one
    through `shell`.
  - The older Machine's own next client then replaces its host, and the link comes back
    on the new build.
  - A development checkout neither upgrades nor is upgraded. A mismatch with one is
    refused, naming both builds.
  - A client never stops or starts a host on another Machine.
  - `FrontDoorRpcs` stays what a client of another build may use
    ([ADR-0038](0038-the-host-builds-and-serves-the-board.md) D5).

**D7. Unreachable is a typed answer, and nothing is queued.**

- **A call while the peer is away.** After a bounded wait it is refused with
  `MachineUnreachable`, which names the Machine and what was seen. It never hangs.
- **Reconnecting.** The control link reconnects with exponential backoff, capped at a
  minute, for as long as the host runs.
- **No queue.** There is no outbox
  ([ADR-0017](0017-one-request-is-one-run.md)). A caller that wants to retry does so under
  the same request id.

**D8. Who asked, across Machines.**

- **`from.machine` is new.** [ADR-0039](0039-every-operation-records-who-asked.md)'s Actor
  gains it, for every front door. It is stamped by D4 and never claimed.
- **A host's own call to a peer is recorded as `host`.** That covers a settings sync, for
  example.
- **The record lives on the receiving Run.** A message from an agent on one Machine to a
  Run on the other is a Delivery made by the receiving Run's host, and it is recorded in
  that Run's `operations.jsonl`
  ([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).
- **Additive, so `PROTOCOL` stays.**

**D9. Settings follow the latest edit, host to host.**

- **When.** Each host syncs its shared settings with each peer when the link comes up,
  and after each edit made on it. It uses the latest-edit merge that Desktop uses, now in
  one place in `src/`.
- **`gitlab_host` is the exception.** It stays given by Desktop only.
- **Converging.** The merge commutes, so Desktop's sync and the hosts' sync agree.

## Considered

- **A `collie machine pair` command, and a `forget`.** Each is a second action for what
  adding the Machine to herdr, or removing it, already says. They would be ceremony
  (invariant 1), so pairing happens on first reach and forgetting follows herdr's list.
- **`--machine` on every cross-Machine command.** A Run id already names its Machine, so
  only a command that names no Run takes it.
- **Refusing a build mismatch with "run `collie upgrade` there".** This asks a human to do
  what the newer host can do, so the newer side upgrades the older one.
- **SSH for upgrades, doctor and credentials while a link is up.** Each one is an SSO
  approval that protects nothing the link had not already authenticated, so they go
  through `shell`.
- **A `peer_port` setting.** It is a knob nobody turns, so the port is fixed at 47217.
- **A hub process that every Machine dials.** It adds a role and a routing layer for a
  Flock of two. D1 is the hub, without either, for as long as one side is always on.
- **A mesh.** A laptop can't be dialled, so a mesh is D1 anyway.
- **SSH for the link.** Every reconnect is an SSO approval, so it can't be unattended.
  SSH stays for what only it can do: the first reach that pairs, Go to pane
  ([ADR-0044](0044-go-to-pane-opens-the-pane-in-desktop.md)), a login's port forward,
  and onboarding a Machine with no Collie yet.
- **One WebSocket carrying calls both ways.** It needs a frame multiplexer of Collie's own.
- **Requests as a subscription stream, answered by callback.** This rebuilds RPC by hand,
  without a schema at each hop.
- **A server per connection.** A second set of front-door handlers would build a second
  board ([ADR-0038](0038-the-host-builds-and-serves-the-board.md), amended 2026-10-07).
  Effect's socket protocol helper is internal. D4 needs neither.
- **Only `FrontDoorRpcs` on the listener.** This protects nothing (D6), and `collie
  --machine run steer` would need a front-door route of its own.

## Consequences

- An agent on either Machine can steer, start, read and stop the other Machine's Runs
  with `collie --machine <name>`, through the same validation and executors as everywhere
  else (invariant 1).
- With Desktop closed, a Schedule can start a Run on the other Machine, and an edit
  spreads.
- Desktop reaches a paired Machine without SSH, so it starts with no SSO approval. SSH is
  opened only for Go to pane, a login's port forward, and onboarding a Machine with no
  Collie yet. Upgrades, doctor and credentials go through `shell`.
- After the VM reboots, its listener is down until something starts its host. Desktop's
  SSH route still starts it. Starting a host at boot is still
  an open item.
- A Machine that has paired listens on the network. Being added to another Machine's
  herdr opens the port, and being removed from it closes the port once the link has
  said so.
- There is no `pair` and no `forget` for a human to run. `collie machine list` only says
  which peers are paired and live.
- Not decided here:
  - a Native chat toolkit that names `<machine>:<id>`;
  - Go to pane and a login's port forward over the link;
  - relaying between two undialable Machines.

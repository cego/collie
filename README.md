# Collie

Codified agent workflows for herdr: `plan`, `implement`, `review`, `architecture` —
deterministic multi-tab orchestrations you pick from a popup. A shared starting point, not a
restriction: fork any workflow or persona into your own layer.

## Install

One command, safe to re-run:

```sh
git clone git@gitlab.cego.dk:mk/collie.git ~/.collie && ~/.collie/setup.sh
```

Collie is internal, so downloading a release asset needs a token. If `glab` is already
logged in to the host, the install borrows that login and you need nothing else; otherwise
set `COLLIE_TOKEN`, or let a machine with bun build from source. See
[Using Collie](docs/using.md#install) for the detail.

## Three keys

| Key              | What it does                               |
| ---------------- | ------------------------------------------ |
| `prefix+f`       | Run a workflow                             |
| `prefix+u`       | Resume a run with unfinished steps         |
| `prefix+shift+f` | Fork a workflow or persona into your layer |

`prefix` is `ctrl+b` by default. The first run in a workspace opens a **Control Plane** tab
as that workspace's first tab (`prefix+1`): live agents, running and finished runs, and
every question a run is waiting on.

## The workflows

| Workflow       | What it does                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`         | Grills you, writes `SPEC.md` and tickets into the run dir, then a menu: implement now, second opinion, offload to Linear, refine      |
| `implement`    | Builds from a plan, a Linear issue or a description on a branch, reviews it with two models, loops on the findings, then opens the MR |
| `review`       | Reviews a merge request, a branch diff or the working tree with two models, synthesizes one review, and offers to post it             |
| `architecture` | Runs the architect over the project, reports into the run dir, then a menu: implement now or stop                                     |

Everything is also a command, so an agent can drive Collie:
`collie run start review --input target=worktree`.

## Documentation

- [Using Collie](docs/using.md) — install, keybindings, the Control Plane, hand-offs,
  your defaults, troubleshooting.
- [Workflows](docs/workflows.md) — what each workflow is for, what it needs, how they chain.
- [Authoring](docs/authoring.md) — layers, forking, `extends:`, the full frontmatter schema.
- [CLI](docs/cli.md) — commands, `--json` envelopes, exit statuses, idempotent retries.
- [Internals](docs/internals.md) — architecture, the Driver, build and release, running the
  tests.
- [`CONTEXT.md`](CONTEXT.md) — the vocabulary.
- [ADRs](docs/adr) — the decisions and why.
- [`AGENTS.md`](AGENTS.md) — where an agent working on this repo should look first.

# A Connection is declared and read

**Status: accepted, built.** The registry, workflow declarations, readings and credential reuse are built here.
Builds on [ADR-0038](0038-the-host-builds-and-serves-the-board.md).

## What was true before

Helle and Linear were optional probes, separate from forge checks.
Front doors had no common reading of a Machine's service logins.
Desktop could not say which Machine had a login another could reuse.

## Decision

**D1. One registry reads each Connection on one Machine.**
[Connection](../../CONTEXT.md) names the domain concept.
The registry contains GitLab, GitHub, Linear, Helle and Slack.
Each probe returns either `{ state: "ok", account, detail }` or
`{ state: "absent" | "broken", detail, fix }`.
`absent` is not set up; `broken` is set up and not working.

Each probe has six seconds and its own failure boundary.
A thrown error or timeout becomes that Connection's `broken` reading and fix.
It never removes another Connection's reading. Cancellation still cancels the read.
Readings contain no credentials and are read afresh when requested.

**D2. The host serves the registry to every front door.**
The additive `connections` board RPC leaves `PROTOCOL` at 4.
`collie connections`, the `collie_connections` Toolkit read and Desktop use it.
Doctor reads the registry locally, because it must also work before a host is running.
Its existing forge prerequisites remain separate; optional Connection lines never fail it.
Workflows read the same registry through `host.connection(id)`.

**D3. Probes use the Machine's existing logins.**
GitLab uses the configured host, otherwise glab's global host, and asks for the token's user.
GitHub reads gh's active login on github.com.
Helle keeps its existing credentials, health check, detail and fix, adding the user id as account.
Linear reads Claude, Codex and OpenCode MCP configurations; it ignores disabled servers.
Its account is the MCP registration name. Configuration discovery cannot establish the authenticated Linear user or OAuth health.
Slack checks the Machine's bot token with `auth.test` and names its workspace and bot.

The formats follow [glab's configuration](https://docs.gitlab.com/cli/config/),
[gh auth status](https://cli.github.com/manual/gh_auth_status),
[Codex MCP configuration](https://developers.openai.com/codex/mcp/) and
[OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/).

**D4. Desktop combines readings and offers explicit credential reuse.**
The merged model retains each Machine's reading, account and fix.
A working login on any Machine makes the service available in the Flock view.
Without one, a broken reading takes precedence over an absent one.
A Machine lacking a working login gets `reusable.from` naming a Machine whose login works.
Reading Connections never moves credentials. An explicit reuse action reads a working
Machine's GitLab or GitHub login through its host and gives it to missing Machines on
stdin. Source credentials remain in place. Desktop keeps the reused GitLab token;
Helle and Slack use their shared token flows. Linear sets up each Machine's MCP and
browser login without copying OAuth credentials.

**D5. Workflows declare required and optional Connections with their consequences.**
`connections.needs` maps ids to `{ with }`; `connections.uses` maps ids to `{ with, without }`.
The host checks ids and nonempty text when loading the workflow.
The existing definitions view carries these declarations for every front door.
A new start is refused before admission when a required reading isn't `ok`, with its fix.
An admitted request retried after a login changes keeps its original admission.
For GitHub repositories and pull requests, `github` stands in for the declared `gitlab` forge requirement.

Each offer or action may list its own `connections`, drawn from its workflow's declarations.
It is hidden only when an id on that list isn't `ok`; an offer without a list stays shown.
The target workflow's required Connections are checked at start, without hiding the offer.
Availability is read again at invocation; a previously drawn offer isn't authority.
Workflow bodies branch on `host.connection(id)` inside an Activity, preserving that reading on replay.
`host.linear` is removed; shipped callers use the Connection reading.

The shipped declarations follow their bodies where the canvas described different work:
plan offers to hand the saved plan to Linear; renovate requires its forge before assessment;
tune-up and self-improve use GitHub as well as GitLab.
Review falls back to the local diff, and release asks the operator to share when Slack is absent.
An implementation given only a Linear id cannot read its work without Linear; it names the fix
and asks for the issue text as an alternative work source.

## Consequences

- A broken service no longer hides healthy services from Settings or chat.
- Older hosts without the RPC produce an unreadable-Connections message, not an empty list.
- Multiple accounts remain visible in the per-Machine readings; the Flock summary names the first working account.
- A missing required login is found before a Run or agent exists; optional service work follows its declared fallback.

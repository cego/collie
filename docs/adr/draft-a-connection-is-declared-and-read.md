# A Connection is declared and read

**Status: accepted, being built.** The registry and its readings are built here.
Workflow declarations and credential reuse build on this boundary in later slices.
Builds on [ADR-0038](0038-the-host-builds-and-serves-the-board.md).

## What was true before

Helle and Linear were optional probes, separate from forge checks.
Front doors had no common reading of a Machine's service logins.
Desktop could not say which Machine had a login another could reuse.

## Decision

**D1. One registry reads each Connection on one Machine.**
[Connection](../../CONTEXT.md) names the domain concept.
The registry contains GitLab, GitHub, Linear and Helle; Slack joins it in its own slice.
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
The workflow's Linear read uses this registry too, without changing what an absent MCP means.

**D3. Probes use the Machine's existing logins.**
GitLab uses the configured host, otherwise glab's global host, and asks for the token's user.
GitHub reads gh's active login on github.com.
Helle keeps its existing credentials, health check, detail and fix, adding the user id as account.
Linear reads Claude, Codex and OpenCode MCP configurations; it ignores disabled servers.
Its account is the MCP registration name. Configuration discovery cannot establish the authenticated Linear user or OAuth health.

The formats follow [glab's configuration](https://docs.gitlab.com/cli/config/),
[gh auth status](https://cli.github.com/manual/gh_auth_status),
[Codex MCP configuration](https://developers.openai.com/codex/mcp/) and
[OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/).

**D4. Desktop combines readings without moving credentials.**
The merged model retains each Machine's reading, account and fix.
A working login on any Machine makes the service available in the Flock view.
Without one, a broken reading takes precedence over an absent one.
A Machine lacking a working login gets `reusable.from` naming a Machine whose login works.
This is discovery only: the later credential hand-over performs and verifies reuse.

## Consequences

- A broken service no longer hides healthy services from Settings or chat.
- Older hosts without the RPC produce an unreadable-Connections message, not an empty list.
- Multiple accounts remain visible in the per-Machine readings; the Flock summary names the first working account.
- Workflow `needs` and `uses` declarations are a separate change; this slice preserves existing start behavior.

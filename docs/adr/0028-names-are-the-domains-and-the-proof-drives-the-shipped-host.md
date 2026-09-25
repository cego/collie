# ADR-0028: Names are the domain's, and the proof drives the host Collie ships

Status: accepted. Supersedes the sentences of ADR-0014, ADR-0015 and ADR-0017 that name
`collie native`, `src/native.ts`, `test/native-runtime.test.ts` or `native.db`.

## Context

While the Markdown engine and Effect's engine ran side by side, the second one was named
for being the second one: `NativeHost`, `NativeAgents`, `NativeChildren`, `NativeDecision`,
a `collie/native` import specifier, `src/native.ts`, `native.db`, and functions such as
`startNativeRun`. ADR-0027 left one engine, so none of those qualifiers distinguishes
anything any more; each one only records which implementation came first.

The recovery proof had the same history. It drove `collie native`, a stdin/stdout fixture
host written before `collie host` existed, and it was a product command that served no
runtime purpose.

## Decision

**Name what exists by what it does.** A module imports from `collie`. What the host lends a
workflow is `Host`; the rest are `Agents`, `Children`, `Decision` and `EntryError`. The
engine, the registry and the SDK a module is served live in `src/engine.ts`, and the host's
SQLite file is `host.db`, beside `host.sock` and `host.lock`. A qualifier stays only where
it separates two real things: a Run is `Hosted` or `Imported`, because the host can act on
the first and only read the second.

**No aliases.** There is no forwarding module, no second import specifier and no fallback
file name. A module that imports `collie/native` does not load.

**The proof drives the shipped host.** `collie native` is gone. The engine, admission and
control suites start `collie host` themselves, so they can kill it, and ask it over the
same RPC every client uses. Typechecking goes through `workflow create`, `workflow check` and
`workflow show`. The one thing a test needs that nothing else does is a host that dies
mid-start: `COLLIE_HOST_CRASH_AT=admitted|executed` makes the host kill itself in one of
the two windows ADR-0017 names, and nothing else sets it.

## Consequences

- An author's imports, the generated `collie.d.ts` and the shipped workflows all say
  `collie`. A module written against a pre-release build has to change its import.
- A `native.db` left by a pre-release build is not read, and neither is anything the old
  engine recorded (ADR-0027).
- The host names a Run, so a test cannot hold a Run before it exists. The proof holds a run
  at the boundary after its decision instead, which is the same property: a hold set
  between attempts is read at the next boundary.
- With `COLLIE_TEST_BINARY` set, those suites exercise the compiled `collie host`, which is
  the thing an installation actually runs.

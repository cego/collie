# 03: Start and inspect workspace-scoped Runs

**What to build:** Let a human or agent start a Workflow directly, receive a Run ID, and list or inspect Runs without opening Collie's UI. Runs must be tied to the intended workspace, start under a detached Driver, and remain safe when an agent retries a command.

**Blocked by:** 01: Run workspace-scoped Workflow discovery through Effect

**Status:** done

- [x] `collie run start <workflow>` accepts repeated `--input key=value`, inline JSON, or JSON from stdin; explicit Inputs override inference.
- [x] Omitted Inputs are inferred from the selected workspace and local state; ambiguity returns `needs_input` with candidates and the Input schema and creates no Run.
- [x] A successful start validates state, creates one Run, launches one detached Driver, and returns its Run ID in readable or JSON output.
- [x] Reusing a start request ID returns the same Run rather than creating or launching another one.
- [x] `collie run list` filters by the selected workspace, while an unscoped invocation lists all Runs.
- [x] `collie run show` rejects a Run recorded for another selected workspace and can inspect a matching Run after its workspace closes.
- [x] Persisted Run boundaries and expected failures are decoded with Effect Schema; malformed state fails visibly instead of being trusted.
- [x] Tests prove detached launch, Input precedence, ambiguous Input behavior, workspace isolation, retry safety, and readable/JSON responses.
- [x] `bun test` and `bun run typecheck` pass.

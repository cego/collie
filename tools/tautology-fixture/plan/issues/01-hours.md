# 01: Hours and compound durations

**What to build:** `parseDuration` reads `h` and compound durations such as `1h30m`;
`formatDuration` writes a duration back; `deadline` adds a duration to a clock's time.

**Blocked by:** None

**Status:** ready-for-agent

**Checks:** `format-exported`: `rg -n "export function formatDuration" src/duration.ts`

## Acceptance criteria

- [ ] `parseDuration("1h30m")` is 5400000.
- [ ] `parseDuration("90s")` is 90000.
- [ ] `formatDuration(5400000)` is `1h30m`.
- [ ] `deadline` is the clock's time plus the duration.
- [ ] `README.md` contains "Reads durations such as `90s`, `5m` and `1h30m` as milliseconds, and writes them back."
- [ ] A reviewer confirms `README.md`'s first paragraph names every unit `parseDuration` reads, as built.

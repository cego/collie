# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop.git
- Incoming revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Canonical installer assets: `skills/install-anti-slop/assets/anti-slop` at that revision. Its sync script copies `src/` while excluding every `*.test.ts` file.
- Recovered base: `6d538555cb151d4121ed51a27db81890eacf8ae9`. The 21 files introduced locally at `93a4fe9bd8ed55ccce1b328a638fc5bad9a9b333` match this upstream revision byte-for-byte.
- Installed paths: `tools/oxlint/anti-slop/index.ts` and `tools/oxlint/anti-slop/effect/index.ts`.

## Local policy retained

- `.oxlintrc.json` keeps the existing plugin paths, ignores, severities, and enabled rules unchanged.
- The locally added ignores for `tools/build.ts`, `tools/herdr-schema.ts`, and `tools/acceptance.ts` remain unchanged.
- Existing enabled rules remain enabled, including only `anti-slop-effect/no-service-constructor-imports` from the Effect plugin.

## Pending rule approvals

The following upstream implementations are vendored but not enabled:

- `anti-slop/no-array-filter-map`
- `anti-slop/no-reduce-accumulator-copy`
- `anti-slop/require-readable-spacing`
- `anti-slop-effect/no-manual-effect-error-tag`
- `anti-slop-effect/no-manual-tag-comparison`
- `anti-slop-effect/no-manual-tagged-construction`
- `anti-slop-effect/prefer-effect-match`

## Verification evidence

- Backup before the update: `/tmp/collie-anti-slop-backup.xuAF08`.
- Exact upstream source and tests: `/tmp/anti-slop-upstream.PL2iES/src`.
- Installed-byte test stage: `/tmp/collie-anti-slop-test-stage.xvv6XD`. It contains an installed-plugin snapshot plus the exact upstream test files and `results.txt`; it is outside the repository and is not shipped.
- From the repository root, rerun all staged upstream tests with Node 26:
  `stage=/tmp/collie-anti-slop-test-stage.xvv6XD; PATH="$stage/bin:$PATH" node --test --test-concurrency=1 $(find "$stage/anti-slop" -name '*.test.ts' | sort)`.
  The temporary `pnpm` shim only lets upstream's readable-spacing CLI test call Collie's installed Oxlint binary; no Node, tsx, pnpm, CI, or repository test-discovery changes are shipped.
- All 24 upstream tests pass with that command. A single staged test can use the simpler runner, for example `node --test "$stage/anti-slop/rules/no-module-mocking.test.ts"`.
- `bun run lint` passes with one pre-existing unused-variable warning in `test/steering-caps.test.ts`; `bun run typecheck` passes.

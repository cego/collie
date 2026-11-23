# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop.git
- Incoming revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Canonical installer assets: `skills/install-anti-slop/assets/anti-slop` at that revision. Its sync script copies `src/` while excluding every `*.test.ts` file.
- Recovered base: `6d538555cb151d4121ed51a27db81890eacf8ae9`. The 21 files introduced locally at `93a4fe9bd8ed55ccce1b328a638fc5bad9a9b333` match this upstream revision byte-for-byte.
- Installed paths: `tools/oxlint/anti-slop/index.ts` and `tools/oxlint/anti-slop/effect/index.ts`.

## Local policy retained

`oxlint.config.ts` takes anti-slop's general rules from `@cloudflare/oxlint-config`'s
`quality/*` plugin. This copy is wired only for the rules the preset has no counterpart for:

- `anti-slop/no-module-mocking`
- `anti-slop/no-runtime-typeof`
- `anti-slop/no-shape-in-symbol-names`
- `anti-slop/no-unknown-parameters`
- `anti-slop/require-safety-comment-for-type-assertion`, with the `WARNING` marker
- `anti-slop-effect/no-service-constructor-imports`

The Effect plugin's other vendored rules (`no-manual-effect-error-tag`,
`no-manual-tag-comparison`, `no-manual-tagged-construction`, `prefer-effect-match`) and
`anti-slop/require-readable-spacing` are not enabled.

## Verification evidence

- Backup before the update: `/tmp/collie-anti-slop-backup.xuAF08`.
- Exact upstream source and tests: `/tmp/anti-slop-upstream.PL2iES/src`.
- Installed-byte test stage: `/tmp/collie-anti-slop-test-stage.xvv6XD`. It contains an installed-plugin snapshot plus the exact upstream test files and `results.txt`; it is outside the repository and is not shipped.
- From the repository root, rerun all staged upstream tests with Node 26:
  `stage=/tmp/collie-anti-slop-test-stage.xvv6XD; PATH="$stage/bin:$PATH" node --test --test-concurrency=1 $(find "$stage/anti-slop" -name '*.test.ts' | sort)`.
  The temporary `pnpm` shim only lets upstream's readable-spacing CLI test call Collie's installed Oxlint binary; no Node, tsx, pnpm, CI, or repository test-discovery changes are shipped.
- All 24 upstream tests pass with that command. A single staged test can use the simpler runner, for example `node --test "$stage/anti-slop/rules/no-module-mocking.test.ts"`.
- `bun run lint` passes with one pre-existing unused-variable warning in `test/steering-caps.test.ts`; `bun run typecheck` passes.

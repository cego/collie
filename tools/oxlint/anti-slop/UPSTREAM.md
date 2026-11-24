# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop.git
- Incoming revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- Canonical installer assets: `skills/install-anti-slop/assets/anti-slop` at that revision. Its sync script copies `src/` while excluding every `*.test.ts` file.
- Recovered base: `6d538555cb151d4121ed51a27db81890eacf8ae9`. The 21 files introduced locally at `93a4fe9bd8ed55ccce1b328a638fc5bad9a9b333` match this upstream revision byte-for-byte.
- Installed paths: `tools/oxlint/anti-slop/index.ts` and `tools/oxlint/anti-slop/effect/index.ts`.

## Local policy retained

`oxlint.config.ts` takes anti-slop's general rules from `@cloudflare/oxlint-config`'s
`quality/*` plugin. Only the rules the preset has no counterpart for are kept here, with
the shared helpers they import (`shared/scope.ts`, `shared/function-parameters.ts`); the
other upstream rules, the Effect plugin's other rules and the vendored eslint-stylistic
code were removed:

- `anti-slop/no-module-mocking`
- `anti-slop/no-runtime-typeof`
- `anti-slop/no-shape-in-symbol-names`
- `anti-slop/no-unknown-parameters`
- `anti-slop/require-safety-comment-for-type-assertion`, with the `WARNING` marker
- `anti-slop-effect/no-service-constructor-imports`

The kept files are byte-for-byte the upstream revision above.

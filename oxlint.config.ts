import cloudflare from "@cloudflare/oxlint-config";
import { correctness, effectNative, strict } from "@effect/tsgo/oxlint-presets";
import landmines from "@interfere/landmines/configs/recommended.json" with { type: "json" };
import { defineConfig } from "oxlint";

const correctnessDefaults = {
  "no-caller": "warn",
  "no-iterator": "warn",
  "no-unassigned-vars": "warn",
  "oxc/bad-array-method-on-arguments": "warn",
  "oxc/bad-match-all-arg": "warn",
  "oxc/erasing-op": "warn",
  "oxc/only-used-in-recursion": "warn",
  "typescript/no-base-to-string": "warn",
  "typescript/no-implied-eval": "warn",
  "typescript/no-meaningless-void-operator": "warn",
  "typescript/no-redundant-type-constituents": "warn",
  "typescript/no-this-alias": "warn",
  "typescript/no-useless-default-assignment": "warn",
  "typescript/no-useless-empty-export": "warn",
  "typescript/restrict-template-expressions": "warn",
  "unicorn/no-await-in-promise-methods": "warn",
  "unicorn/no-empty-file": "warn",
  "unicorn/no-new-array": "warn",
  "unicorn/no-single-promise-in-promise-methods": "warn",
  "unicorn/no-thenable": "warn",
  "unicorn/no-unnecessary-await": "warn",
  "unicorn/no-useless-fallback-in-spread": "warn",
  "unicorn/no-useless-length-check": "warn",
  "unicorn/prefer-string-starts-ends-with": "warn",
} as const;

const unfit = {
  // WARNING: oxlint 1.94 reports a let reassigned after a closure captures it, as in test/run-model.test.ts.
  "prefer-const": "off",
  // WARNING: it rewrites the prose "UTF-8" in a message assertion as an encoding id.
  "unicorn/text-encoding-identifier-case": "off",
  // WARNING: it reads Effect.catch as a catch clause, and its fix renames shorthand properties.
  "unicorn/catch-error-name": "off",
  // WARNING: it reads Effect.map as Array#map.
  "array-callback-return": "off",
  // WARNING: it reads Effect.catch as a promise chain.
  "unicorn/prefer-top-level-await": "off",
  // WARNING: Effect's tagged errors and forges' errors are told apart by their class.
  "@nkzw/no-instanceof": "off",
  // WARNING: a workflow's state is replaced, never mutated, and its loops run a handful of rounds.
  "oxc/no-accumulating-spread": "off",
  // WARNING: Effect's modules are namespaces by design, imported whole as `import * as`.
  "import/no-namespace": "off",
  // WARNING: the terminal UI is Solid on OpenTUI, whose JSX props and reactive stores React's rules misread.
  "react/immutability": "off",
  "react/no-unknown-property": "off",
  "react/refs": "off",
  // WARNING: it reads a service's `.use(...)`, such as the SQL client's, as React's `use` hook.
  "react-hooks/rules-of-hooks": "off",
} as const;

const migrating = {
  "typescript/no-non-null-assertion": "off",
  "typescript/no-unsafe-argument": "off",
  "typescript/no-unsafe-assignment": "off",
  "typescript/no-unsafe-call": "off",
  "typescript/no-unsafe-member-access": "off",
  "typescript/no-unsafe-return": "off",
  "typescript/no-unsafe-type-assertion": "off",
  "unicorn/consistent-function-scoping": "off",
} as const;

export default defineConfig({
  ...cloudflare,
  extends: [correctness, effectNative, strict, landmines],
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "desktop/vendor/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".scratch/**",
    ".windsurf/**",
    "advisor-plans/**",
    "plans/**",
    // WARNING: workflow modules an author would write are checked by the provisioned toolchain.
    "test/fixtures/workflows/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    ...cloudflare.jsPlugins,
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    ...cloudflare.rules,
    ...correctnessDefaults,
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/require-safety-comment-for-type-assertion": ["error", { markers: ["WARNING"] }],
    "anti-slop-effect/no-service-constructor-imports": "error",
    "landmines-style/no-comments": [
      "error",
      { publicApi: [String.raw`/src/(sdk|collie-module)\.ts$`] },
    ],
    "effecttsgo/any-unknown-in-error-context": "error",
    "effecttsgo/prefer-effect-array": "error",
    "effecttsgo/prefer-effect-string": "error",
    "effecttsgo/prefer-effect-record": "error",
    "effecttsgo/global-console": "error",
    "effecttsgo/global-date": "error",
    "effecttsgo/abort-controller-in-effect": "error",
    "effecttsgo/async-function": "error",
    "effecttsgo/crypto-random-uuid": "error",
    "effecttsgo/crypto-random-uuid-in-effect": "error",
    "effecttsgo/extends-native-error": "error",
    "effecttsgo/global-console-in-effect": "error",
    "effecttsgo/global-date-in-effect": "error",
    "effecttsgo/global-fetch": "error",
    "effecttsgo/global-fetch-in-effect": "error",
    "effecttsgo/global-random": "error",
    "effecttsgo/global-random-in-effect": "error",
    "effecttsgo/global-timers": "error",
    "effecttsgo/global-timers-in-effect": "error",
    "effecttsgo/instance-of-schema": "error",
    "effecttsgo/new-promise": "error",
    "effecttsgo/node-builtin-import": "error",
    "effecttsgo/schema-sync": "error",
    // WARNING: Collie runs on Effect's unstable workflow and cluster modules by decision (ADR-0014).
    "effecttsgo/unstable-api-usage": "off",
    "effecttsgo/prefer-schema-over-json": "error",
    "effecttsgo/process-env": "error",
    "effecttsgo/process-env-in-effect": "error",
    "effecttsgo/unsafe-effect-type-assertion": "error",
    "no-restricted-globals": [
      "error",
      {
        name: "Date",
        message:
          "Use Clock.currentTimeMillis or DateTime.now for now, and DateTime or epochMs (src/time.ts) for a timestamp.",
      },
      { name: "performance", message: "Use Clock.currentTimeMillis or Clock.currentTimeNanos." },
    ],
    "no-restricted-properties": [
      "error",
      { object: "Bun", property: "sleep", message: "Use Effect.sleep, which a test clock moves." },
      {
        object: "Bun",
        property: "sleepSync",
        message: "Use Effect.sleep, which a test clock moves.",
      },
      { object: "Bun", property: "nanoseconds", message: "Use Clock.currentTimeNanos." },
      { object: "process", property: "hrtime", message: "Use Clock.currentTimeNanos." },
    ],
    "typescript/no-restricted-types": [
      "error",
      { types: { Date: { message: "A time is a DateTime, or epoch milliseconds." } } },
    ],
    // WARNING: `== null` matches null and undefined alike, on purpose.
    eqeqeq: ["error", "always", { null: "ignore" }],
    // WARNING: a failed cleanup is ignored on purpose; there is nothing left to tell.
    "no-empty": ["error", { allowEmptyCatch: true }],
    // WARNING: an interface extending a Schema's Type names it without widening.
    "@typescript-eslint/no-empty-object-type": [
      "error",
      { allowInterfaces: "with-single-extends" },
    ],
    // WARNING: Promise#finally waits for the promise its callback returns.
    "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    ...migrating,
    ...unfit,
  },
  overrides: [
    ...cloudflare.overrides,
    {
      // WARNING: these drivers and core ports speak to processes and sockets on their own terms.
      files: [
        "desktop/core/platform.ts",
        "desktop/core/record-terminal.ts",
        "bench/desktop-start/run.ts",
        "bench/desktop-start/start.ts",
        "bench/record-open/record-open.fixture.ts",
        "bench/record-open/world.ts",
      ],
      rules: {
        "effecttsgo/async-function": "off",
        "effecttsgo/global-console": "off",
        "effecttsgo/global-console-in-effect": "off",
        "effecttsgo/global-date": "off",
        "effecttsgo/global-date-in-effect": "off",
        "effecttsgo/global-fetch": "off",
        "effecttsgo/global-fetch-in-effect": "off",
        "effecttsgo/new-promise": "off",
        "effecttsgo/node-builtin-import": "off",
        "effecttsgo/prefer-effect-array": "off",
        "effecttsgo/prefer-effect-record": "off",
        "effecttsgo/prefer-effect-string": "off",
        "effecttsgo/prefer-schema-over-json": "off",
        "no-restricted-globals": "off",
        "no-restricted-properties": "off",
      },
    },
    {
      files: ["bench/**", "desktop/core/platform.ts", "desktop/core/record-terminal.ts"],
      rules: { "no-console": "off" },
    },
    {
      // WARNING: Effect's Crypto has no Ed25519 sign, verify or keypair.
      files: [
        "src/signing.ts",
        "test/desktop-credentials.test.ts",
        "test/desktop-onboarding.test.ts",
        "test/desktop-peers.test.ts",
        "test/desktop-updates.test.ts",
        "test/desktop-upgrade.test.ts",
        "test/install-desktop.test.ts",
        "test/prepare.test.ts",
        "test/signing.test.ts",
        "test/upgrade-release.test.ts",
        "test/setup.test.ts",
        "test/upgrade-clone.test.ts",
      ],
      rules: { "effecttsgo/node-builtin-import": "off" },
    },
    {
      files: ["src/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@effect/platform-bun",
                message:
                  "Import the module you use (`@effect/platform-bun/BunServices`): the index loads all of them, ~0.1 s of every start.",
              },
              {
                name: "effect/http",
                message:
                  "Import the module you use (`effect/http/HttpClient`): the index loads the server too.",
              },
              {
                name: "effect/ai",
                message:
                  "Import the module you use (`effect/ai/Tool`): the index loads McpServer and LanguageModel into every chat hook.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["**/*"],
      rules: {
        ...migrating,
        ...unfit,
        // WARNING: the preset leaves no-unreachable to tsc for TypeScript, but tsc only hints at unreachable code without allowUnreachableCode: false.
        "no-unreachable": "warn",
      },
    },
  ],
});

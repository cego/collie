import { expect, test } from "bun:test";
import * as Str from "effect/String";
import { Option, Result } from "effect";
import {
  mapVueDiagnostic,
  projectVue,
  projectionIncludes,
  rewriteProjection,
  type VueDiagnostic,
  type VueProjection,
} from "../tools/lint-vue";

test("the projection program keeps Nuxt ambient globals and project declarations", () => {
  const includes = projectionIncludes([
    "/project/.nuxt/nuxt.d.ts",
    "/project/app/types.d.ts",
    "/project/app/globals.ts",
  ]);
  expect(includes).toContain("/project/.nuxt/nuxt.d.ts");
  expect(includes).toContain("/project/app/types.d.ts");
  expect(includes).toContain("/project/app/globals.ts");
});

const source = `<script setup lang="ts">
import { Effect } from "effect";
// π
const props = defineProps<{ names: string[] }>();
const names = props.names.map((name) => name.trim());
</script>
<template>{{ names }}</template>
`;

const projected = () => Result.getOrThrow(projectVue("/project/Names.vue", source));

const diagnostic = (
  projection: VueProjection,
  token: string,
  length = token.length,
  fromEnd = false,
): VueDiagnostic => ({
  filename: "/temporary/Names.ts",
  code: "effecttsgo/prefer-effect-array",
  message: "Use Effect Array",
  severity: "error",
  labels: [
    {
      span: {
        offset: new TextEncoder().encode(
          Str.slice(
            0,
            Option.getOrThrow(
              (fromEnd ? Str.lastIndexOf(token) : Str.indexOf(token))(projection.code),
            ),
          )(projection.code),
        ).length,
        length,
        line: 1,
        column: 1,
      },
    },
  ],
});

test("Vue projection keeps typed props and script calls for semantic lint", () => {
  const projection = projected();
  expect(projection.code).toContain("names: string[]");
  expect(projection.code).toContain("props.names.map((name) => name.trim())");
  expect(projection.extension).toBe(".ts");
});

test("a semantic diagnostic points at the original Vue method after Unicode text", () => {
  const projection = projected();
  const mapped = mapVueDiagnostic(projection, diagnostic(projection, "map((name)"));
  expect(mapped?.filename).toBe("/project/Names.vue");
  expect(mapped?.labels[0]?.span).toMatchObject({ line: 5, column: 27 });
});

test("compiler-only helpers are outside the authored lint surface", () => {
  const projection = projected();
  expect(mapVueDiagnostic(projection, diagnostic(projection, "__VLS_ctx"))).toBeNull();
});

const modalProjection = () =>
  Result.getOrThrow(
    projectVue(
      "/project/Modal.vue",
      `<script setup lang="ts">
const open = defineModel<boolean>("open");
const props = defineProps<{ names: string[] }>();
</script>
<template><UModal v-model:open="open" :title="props.names.map(name => name.trim()).join(',')" /></template>`,
    ),
  );

test("a compiled component attribute key is not an authored method reference", () => {
  const projection = modalProjection();
  expect(
    mapVueDiagnostic(projection, {
      ...diagnostic(projection, "open: (__VLS_unwrap", 4, true),
      code: "typescript(unbound-method)",
    }),
  ).toBeNull();
});

test("native helpers in a component attribute expression remain lintable", () => {
  const projection = modalProjection();
  expect(
    mapVueDiagnostic(projection, diagnostic(projection, "map(name", 3, true))?.labels[0]?.span,
  ).toMatchObject({ line: 5, column: 59 });
  expect(
    mapVueDiagnostic(projection, diagnostic(projection, "trim()", 4, true))?.labels[0]?.span,
  ).toMatchObject({ line: 5, column: 76 });
});

test("a static slot name is not an authored destructured method", () => {
  const projection = Result.getOrThrow(
    projectVue(
      "/project/Slots.vue",
      `<script setup lang="ts">const props = defineProps<{ names: string[] }>();</script>
<template><UModal><template #body>{{ props.names.map(name => name.trim()) }}</template></UModal></template>`,
    ),
  );
  expect(
    mapVueDiagnostic(projection, {
      ...diagnostic(projection, "body: __VLS_", 4),
      code: "typescript(unbound-method)",
    }),
  ).toBeNull();
  expect(
    mapVueDiagnostic(projection, diagnostic(projection, "map(name", 3))?.labels[0]?.span,
  ).toMatchObject({ line: 2, column: 50 });
});

test("conditional slots exclude static names and keep their expression helpers", () => {
  const projection = Result.getOrThrow(
    projectVue(
      "/project/ConditionalSlots.vue",
      `<script setup lang="ts">const props = defineProps<{ names: string[] }>();</script>
<template><div v-if="props.names.length"><UModal><template #body>{{ props.names.map(name => name.trim()) }}</template></UModal></div></template>`,
    ),
  );
  expect(
    mapVueDiagnostic(projection, {
      ...diagnostic(projection, "body: __VLS_", 4),
      code: "typescript(unbound-method)",
    }),
  ).toBeNull();
  expect(mapVueDiagnostic(projection, diagnostic(projection, "map(name", 3))).not.toBeNull();
});

test("a generated cast around a mapped Vue macro is not an authored assertion", () => {
  const projection = Result.getOrThrow(
    projectVue(
      "/project/TemplateRef.vue",
      '<script setup lang="ts">const detail = useTemplateRef("detail");</script><template><div ref="detail" /></template>',
    ),
  );
  const assertion = /useTemplateRef\(.* as Readonly<.*>>/.exec(projection.code)?.[0];
  expect(assertion).toBeDefined();
  expect(
    mapVueDiagnostic(
      projection,
      diagnostic(projection, assertion ?? "missing generated assertion"),
    ),
  ).toBeNull();
});

test("rewritten module paths retain the following Vue diagnostic location", () => {
  const projection = rewriteProjection(projected(), (name) =>
    name === "effect" ? "/a/longer/effect/module.d.ts" : null,
  );
  expect(projection.code).toContain('"/a/longer/effect/module.d.ts"');
  expect(
    mapVueDiagnostic(projection, diagnostic(projection, "map((name)"))?.labels[0]?.span,
  ).toMatchObject({ line: 5, column: 27 });
});

test("a malformed Vue file is refused instead of silently skipping semantic lint", () => {
  const result = projectVue("/project/Broken.vue", '<script setup lang="ts">const x =');
  expect(Result.isFailure(result)).toBe(true);
});

test("malformed TypeScript in a closed Vue script is refused before projection lint", () => {
  const result = projectVue(
    "/project/BrokenScript.vue",
    '<script setup lang="ts">const value =</script><template><span /></template>',
  );
  expect(Result.isFailure(result)).toBe(true);
});

test("a scriptless Vue component still has a lint projection", () => {
  const projection = Result.getOrThrow(
    projectVue("/project/Template.vue", "<template><span>hello</span></template>"),
  );
  expect(
    mapVueDiagnostic(projection, diagnostic(projection, "span"))?.labels[0]?.span,
  ).toMatchObject({ line: 1, column: 12 });
});

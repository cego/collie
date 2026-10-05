<script setup lang="ts">
// Agent-written markdown, which is untrusted: parsed by Comark, sanitised, with Shiki for
// code and mermaid for diagrams. A link never navigates the window.
import { Markdown } from "@comark/vue";
import mermaid, { Mermaid } from "@comark/vue/plugins/mermaid";
import security from "@comark/vue/plugins/security";
import shiki from "@comark/vue/plugins/shiki";
import MarkdownLink from "./MarkdownLink.vue";

const props = defineProps<{
  text: string;
  /** The plan file this was read from, which its relative links are resolved against. */
  from?: string;
}>();
provide(
  "markdownFrom",
  computed(() => props.from),
);

const PLUGINS = [
  security({ blockedTags: ["script", "style", "iframe", "object", "embed"] }),
  shiki(),
  mermaid(),
];
const COMPONENTS = { a: MarkdownLink, mermaid: Mermaid };
</script>

<template>
  <div class="text-sm" data-testid="markdown">
    <Suspense>
      <Markdown :key="text" :value="text" :plugins="PLUGINS" :components="COMPONENTS" />
      <template #fallback><p class="text-muted text-sm">Rendering…</p></template>
    </Suspense>
  </div>
</template>

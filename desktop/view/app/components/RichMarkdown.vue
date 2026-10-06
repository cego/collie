<script setup lang="ts">
// Agent-written markdown, which is untrusted. A link never navigates the window.
import { Markdown } from "@comark/vue";
import mermaid, { Mermaid } from "@comark/vue/plugins/mermaid";
import security from "@comark/vue/plugins/security";
import shiki from "@comark/vue/plugins/shiki";
import { confined } from "../../../src/shared/markdown";
import FileRef from "./FileRef.vue";
import MarkdownLink from "./MarkdownLink.vue";

const props = defineProps<{
  text: string;
  streaming?: boolean;
  /** The plan file this was read from, which its relative links are resolved against. */
  from?: string;
}>();
provide(
  "markdownFrom",
  computed(() => props.from),
);

const PLUGINS = [
  security({
    blockedTags: [
      ...["script", "style", "iframe", "object", "embed", "form", "base", "link", "meta"],
      // Modal, so it would make the whole window inert.
      "dialog",
    ],
    // Nothing is fetched from the network: an image a Run kept is evidence, read from its host.
    allowedImagePrefixes: ["data:image/"],
  }),
  confined(),
  shiki(),
  mermaid(),
];
const COMPONENTS = { a: MarkdownLink, mermaid: Mermaid, "file-ref": FileRef };
</script>

<template>
  <!-- Contained, so nothing an agent positions can leave it; scrolled, so nothing wide is cut. -->
  <div class="overflow-x-auto text-sm [contain:paint]" data-testid="markdown">
    <Suspense>
      <Markdown :value="text" :streaming="streaming" :plugins="PLUGINS" :components="COMPONENTS" />
      <template #fallback><p class="text-muted text-sm">Rendering…</p></template>
    </Suspense>
  </div>
</template>

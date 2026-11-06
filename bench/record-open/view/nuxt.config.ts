// Desktop's view with Electrobun's transport swapped for the benchmark's WebSocket. Vue's
// production devtools hooks are on, so the harness can read the Flow FlowMap rendered.

const view = new URL("../../../desktop/view/", import.meta.url).pathname;

export default defineNuxtConfig({
  extends: [view],
  srcDir: `${view}app`,
  alias: { "electrobun/view": new URL("./electrobun-view.ts", import.meta.url).pathname },
  vite: { define: { __VUE_PROD_DEVTOOLS__: "true" } },
});

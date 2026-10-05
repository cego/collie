// Desktop's view: a Nuxt SPA generated to static files that Electrobun serves from
// views://mainview/. Nothing may come from the network at runtime.

export default defineNuxtConfig({
  // @comark/nuxt turns on Nuxt UI's prose components, which style rendered markdown.
  modules: ["@nuxt/ui", "@comark/nuxt"],
  css: ["~/assets/css/main.css"],
  ssr: false,
  experimental: {
    // Its _nuxt/builds/meta/<uuid>.json path is long enough to need a GNU long-name tar
    // entry, which Electrobun's installer cannot extract; an SPA needs no app manifest.
    appManifest: false,
  },
  // @nuxt/fonts' file names are too long for the installer for the same reason; the font
  // comes from @fontsource-variable/public-sans instead.
  ui: { fonts: false },
  vite: {
    // Every view file sits under a 52-character prefix in the installer's payload, whose
    // paths may not pass 100.
    $client: {
      build: { rolldownOptions: { output: { assetFileNames: "_nuxt/[hash][extname]" } } },
    },
  },
  // Icons are compiled into the bundle from @iconify-json/lucide, never fetched.
  icon: { provider: "none", fallbackToApi: false, clientBundle: { scan: true } },
  alias: {
    "electrobun/view": new URL("../.hutch/devkit/api/browser/index.ts", import.meta.url).pathname,
  },
  devtools: { enabled: false },
  telemetry: false,
  compatibilityDate: "2026-10-01",
});

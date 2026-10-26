/**
 * What Nuxt Icon scans for the icon names compiled into the view's bundle: its own default,
 * and the shared modules that hand the view an icon by name.
 */
export const iconScan = {
  globInclude: ["**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}", "../src/shared/*.ts"],
};

# Desktop draws at its monitor's own scale

**Status: accepted, built** (`desktop/src/shared/scale.ts` decides, `desktop/src/bun/scale.ts`
applies). Nothing earlier said how large Desktop draws; it drew at
whatever scale its renderer was handed.

## What was true before

Electrobun 2.0.2 runs CEF on Linux with `ozone-platform=x11`, because it embeds the browser
as an X11 child of its own GTK window. On a Wayland session Desktop is therefore an XWayland
client, whatever the session's other apps are.

Omarchy (Hyprland) sets `xwayland.force_zero_scaling = true`, so the compositor leaves
XWayland windows unscaled, and sets one global `GDK_SCALE=2` (GTK only honours whole
numbers). Hyprland gives each monitor its own scale, which can be a fraction: `auto` picks
about 1.6 on a laptop panel, 1.5 or 2 on a 4K monitor and 1 on a 2560×1440 one. Native
Wayland apps, such as Chrome with `OZONE_PLATFORM=wayland`, follow each monitor's scale.
Desktop draws at 2 on every monitor. A record photographed on 2026-10-08 measures two device
pixels per CSS pixel, and the window's title bar is drawn at 2× too.

So Desktop is the one app on the screen that is too large: by a third on a 1.5 monitor, by
a quarter on a 1.6 laptop and twice too large on a 1× monitor. The cause is how Desktop is
scaled, not its type sizes.

## Decision

**D1. Desktop's zoom is the human's Zoom × (the monitor's own scale ÷ the scale Desktop is
drawn at).** It is applied as the webview's page zoom, which is Chromium's own zoom: layout
reflows into the larger CSS viewport and text is rasterised at the resulting density, so it
stays crisp. Electrobun's Linux CEF wrapper implements `setPageZoom`
(`CEFWebViewImpl::applyRequestedPageZoom`), though its TypeScript doc still says WebKit only.
Every Desktop window gets it, the popped-out Flock chat included. It is decided again when a
window moves, resizes or takes focus, so moving the window to another monitor resizes it.

**D2. The monitor's own scale is read from the compositor.** On Hyprland it comes from
`hyprctl -j`: the client whose pid is Desktop's gives its monitor, and that monitor gives
its scale. The scale Desktop is drawn at is the one its renderer reports for the window's
display. Where Desktop cannot read the monitor's scale, as on any other Wayland compositor,
the factor is 1 and Settings says the monitor's scale is unknown. On an X11 session the
drawn scale already is the screen's, so the factor is 1 there too.

**D3. Zoom is this computer's setting.** It is kept with Desktop's own settings and never
given to a Machine. 100% means the size of the other apps on that monitor.

**D4. Settings says how Desktop is drawn**: the monitor, its own scale, the scale Desktop is
drawn at, the zoom applied, and the device pixel ratio the view ends up with. A mismatch can
be read off the screen instead of guessed.

## Rejected

- **`force-device-scale-factor` in `chromiumFlags`.** It is fixed when Desktop is built and
  is one value for every monitor, and one setup can have a 4K monitor and a 2560×1440 one
  side by side.
- **`ozone-platform=wayland`.** Electrobun parents the browser in an X11 window, so a
  Wayland browser would not embed.
- **`GDK_SCALE=1` in the launcher entry.** It is still one value for every monitor, and it
  shrinks the GTK window's own chrome on a HiDPI monitor.
- **Smaller type by hand.** It would be right on one monitor and wrong on the others.
- **CSS `zoom` on the root.** Page zoom resizes the viewport itself. A style on the root
  has to be matched by every viewport-sized layout and every floating overlay.

## Consequences

Only Hyprland is read (`ponytail:` the ceiling). GNOME (Mutter's `DisplayConfig`) and KDE
(`kscreen-doctor`) are added when someone runs Desktop there. If Electrobun ever runs CEF
natively on Wayland, D1's factor becomes 1 and the compositor reading can go.

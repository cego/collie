// Draws each Desktop window at its monitor's own scale (ADR-0047): Hyprland says which
// monitor holds it and that monitor's scale, Electrobun the scale it is rendered at, and
// the page zoom makes up the difference. Decided again as a window moves, resizes or takes
// focus, and whenever Zoom changes.

import { type BrowserWindow, Screen } from "electrobun/bun";
import { Effect, Queue, Stream } from "effect";
import { type Drawn, type MonitorScale, monitorOf, zoomFor } from "../shared/scale";
import { output } from "./machine";

// ponytail: Hyprland only; GNOME and KDE are read once someone runs Desktop there (ADR-0047).
const monitorScale = (title: string): Effect.Effect<MonitorScale> =>
  Bun.env.HYPRLAND_INSTANCE_SIGNATURE === undefined
    ? Effect.succeed({ _tag: "Unknown", reason: "This is not a Hyprland session" })
    : Effect.all([
        output(["hyprctl", "-j", "clients"]),
        output(["hyprctl", "-j", "monitors"]),
      ]).pipe(
        Effect.map(([clients, monitors]) => monitorOf(clients, monitors, process.pid, title)),
        Effect.orElseSucceed((): MonitorScale => ({
          _tag: "Unknown",
          reason: "hyprctl could not be run",
        })),
      );

/** The scale Electrobun renders the window at: its display's, the one holding its centre. */
const renderedScale = (window: BrowserWindow) => {
  const { x, y, width, height } = window.getFrame();
  const [cx, cy] = [x + width / 2, y + height / 2];
  const displays = Screen.getAllDisplays();
  const holding = displays.find(
    ({ bounds }) =>
      cx >= bounds.x &&
      cx < bounds.x + bounds.width &&
      cy >= bounds.y &&
      cy < bounds.y + bounds.height,
  );
  return (holding ?? Screen.getPrimaryDisplay()).scaleFactor || 1;
};

/** Zooms `window` for its monitor and `preference`, and says how it is now drawn. */
export const zoomWindow = (window: BrowserWindow, title: string, preference: number) =>
  Effect.map(monitorScale(title), (monitor): Drawn => {
    const rendered = renderedScale(window);
    const zoom = zoomFor(preference, monitor, rendered);
    window.setPageZoom(zoom);
    return { monitor, rendered, zoom, preference };
  });

/**
 * Asks for `window` to be zoomed now, and again, settled, after each move, resize or focus.
 * The returned effect asks again by hand, as a change of Zoom does.
 */
export const followWindow = (window: BrowserWindow) =>
  Effect.gen(function* () {
    const asked = yield* Queue.sliding<void>(1);
    for (const event of ["move", "resize", "focus"])
      window.on(event, () => Queue.offerUnsafe(asked, undefined));
    const again = Queue.offer(asked, undefined);
    yield* again;
    return {
      again,
      asked: Stream.fromQueue(asked).pipe(Stream.debounce("250 millis")),
    };
  });

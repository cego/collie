// How large Desktop draws (ADR-0047): the monitor holding its window, as Hyprland says, and
// the page zoom that brings the scale it is rendered at to that monitor's own.
// No Bun-only import: the view bundles this.

import { Option, Schema } from "effect";

const HyprClients = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ pid: Schema.Number, monitor: Schema.Number, title: Schema.String })),
);
const HyprMonitors = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
      scale: Schema.Number,
    }),
  ),
);

export const MonitorScale = Schema.Union([
  Schema.TaggedStruct("Known", {
    name: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    scale: Schema.Number,
  }),
  Schema.TaggedStruct("Unknown", { reason: Schema.String }),
]);
export type MonitorScale = typeof MonitorScale.Type;

/** How a window is drawn, as Settings is told it. */
export const Drawn = Schema.Struct({
  monitor: MonitorScale,
  /** The scale the renderer draws the window at, before zoom. */
  rendered: Schema.Number,
  zoom: Schema.Number,
  /** The human's Zoom. */
  preference: Schema.Number,
});
export type Drawn = typeof Drawn.Type;

const unknown = (reason: string): MonitorScale => ({ _tag: "Unknown", reason });

/**
 * The monitor of Desktop's window titled `title`, from `hyprctl -j clients` and `monitors`;
 * any window of Desktop's where none has that title.
 */
export const monitorOf = (
  clients: string,
  monitors: string,
  pid: number,
  title: string,
): MonitorScale => {
  const listed = Schema.decodeUnknownOption(HyprClients)(clients);
  const shown = Schema.decodeUnknownOption(HyprMonitors)(monitors);
  if (Option.isNone(listed) || Option.isNone(shown))
    return unknown("Hyprland's answer could not be read");
  const mine = listed.value.filter((client) => client.pid === pid);
  const window = mine.find((client) => client.title === title) ?? mine[0];
  if (window === undefined) return unknown("Hyprland lists no window of Desktop's");
  const monitor = shown.value.find(({ id }) => id === window.monitor);
  if (monitor === undefined) return unknown("Hyprland lists no monitor for Desktop's window");
  const { name, width, height, scale } = monitor;
  return { _tag: "Known", name, width, height, scale };
};

/** The page zoom: the human's Zoom, corrected from the rendered scale to the monitor's. */
export const zoomFor = (preference: number, monitor: MonitorScale, rendered: number) =>
  Math.min(
    4,
    Math.max(0.25, preference * (monitor._tag === "Known" ? monitor.scale / rendered : 1)),
  );

const times = (scale: number) => `${Number(scale.toFixed(2))}×`;
const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/** How Settings says a window is drawn, with the pixel ratio its view ends up at. */
export const drawnSaid = (
  { monitor, rendered, zoom, preference }: Drawn,
  devicePixelRatio: number,
) => {
  const expected = rendered * zoom;
  const said =
    monitor._tag === "Known"
      ? `Drawn at ${times(expected)} on ${monitor.name} (${monitor.width}×${monitor.height}, Hyprland scale ${Number(monitor.scale.toFixed(2))}). Rendered at ${times(rendered)}, so zoom ${percent(zoom / preference)} × your ${percent(preference)}.`
      : `This desktop's monitor scale is not known to Desktop; drawn at ${times(rendered)}, zoom ${percent(zoom)}. ${monitor.reason}.`;
  return Math.abs(devicePixelRatio - expected) < 0.01
    ? said
    : `${said} Yet this window draws at ${times(devicePixelRatio)}, so the zoom has not taken.`;
};

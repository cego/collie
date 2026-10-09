// Desktop draws at its monitor's own scale (ADR-0047): which monitor holds its window, read
// from Hyprland, the zoom that corrects the scale it is rendered at, and how Settings says it.

import { expect, test } from "bun:test";
import { type Drawn, drawnSaid, monitorOf, zoomFor } from "../desktop/src/shared/scale";

// As `hyprctl -j monitors` prints them, trimmed to what is read.
const LAPTOP = {
  id: 0,
  name: "eDP-1",
  description: "BOE 0x0BCA",
  width: 2880,
  height: 1920,
  x: 0,
  y: 0,
  scale: 1.6,
  focused: true,
};
const FOURK = {
  id: 1,
  name: "DP-1",
  description: "Dell U2723QE",
  width: 3840,
  height: 2160,
  x: 1800,
  y: 0,
  scale: 1.5,
  focused: false,
};
const QHD = {
  id: 2,
  name: "DP-2",
  description: "LG 27GL850",
  width: 2560,
  height: 1440,
  x: 4360,
  y: 0,
  scale: 1,
  focused: false,
};

// As `hyprctl -j clients` prints them: Desktop is an XWayland client, one per window.
const client = (pid: number, monitor: number, title: string, xwayland = true) => ({
  address: `0x${pid.toString(16)}${monitor}`,
  mapped: true,
  hidden: false,
  at: [0, 0],
  size: [1200, 800],
  workspace: { id: monitor + 1, name: `${monitor + 1}` },
  floating: false,
  monitor,
  class: xwayland ? "Collie" : "chromium",
  title,
  pid,
  xwayland,
});

const json = <A>(value: A) => JSON.stringify(value);

test("on one monitor, Desktop's window is on it", () => {
  expect(monitorOf(json([client(4242, 0, "Collie")]), json([LAPTOP]), 4242, "Collie")).toEqual({
    _tag: "Known",
    name: "eDP-1",
    width: 2880,
    height: 1920,
    scale: 1.6,
  });
});

test("with two monitors at different scales, each window is on the one Hyprland puts it on", () => {
  const clients = json([
    client(9, 2, "Slack", false),
    client(4242, 1, "Collie"),
    client(4242, 2, "Flock chat"),
  ]);
  const monitors = json([LAPTOP, FOURK, QHD]);
  expect(monitorOf(clients, monitors, 4242, "Collie")).toMatchObject({ name: "DP-1", scale: 1.5 });
  expect(monitorOf(clients, monitors, 4242, "Flock chat")).toMatchObject({
    name: "DP-2",
    scale: 1,
  });
});

test("an XWayland client whose title Desktop does not know is still Desktop's by its pid", () => {
  expect(
    monitorOf(json([client(4242, 1, "collie-desktop")]), json([FOURK]), 4242, "Collie"),
  ).toMatchObject({ name: "DP-1" });
});

test("with no client of Desktop's, or output that is not Hyprland's, the scale is unknown and says why", () => {
  expect(monitorOf(json([client(9, 0, "Slack", false)]), json([LAPTOP]), 4242, "Collie")).toEqual({
    _tag: "Unknown",
    reason: "Hyprland lists no window of Desktop's",
  });
  expect(monitorOf("not json", json([LAPTOP]), 4242, "Collie")).toMatchObject({
    _tag: "Unknown",
  });
});

test("the zoom is Zoom × the monitor's scale ÷ the scale Desktop is rendered at, within 25% and 400%", () => {
  const on = (scale: number) =>
    ({ _tag: "Known", name: "DP-1", width: 1, height: 1, scale }) as const;
  expect(zoomFor(1, on(1.5), 2)).toBe(0.75);
  expect(zoomFor(1.25, on(1.6), 2)).toBe(1);
  expect(zoomFor(1, on(1), 1)).toBe(1);
  expect(zoomFor(0.8, { _tag: "Unknown", reason: "not Hyprland" }, 2)).toBe(0.8);
  expect(zoomFor(1, on(0.1), 2)).toBe(0.25);
  expect(zoomFor(1.5, on(8), 1)).toBe(4);
});

const onFourK: Drawn = {
  monitor: { _tag: "Known", name: "DP-1", width: 3840, height: 2160, scale: 1.5 },
  rendered: 2,
  zoom: 0.75,
  preference: 1,
};

test("Settings says how Desktop is drawn on a Hyprland monitor", () => {
  expect(drawnSaid(onFourK, 1.5)).toBe(
    "Drawn at 1.5× on DP-1 (3840×2160, Hyprland scale 1.5). Rendered at 2×, so zoom 75% × your 100%.",
  );
});

test("Settings says when the monitor's scale is unknown, and why", () => {
  expect(
    drawnSaid(
      {
        monitor: { _tag: "Unknown", reason: "This is not a Hyprland session" },
        rendered: 2,
        zoom: 1,
        preference: 1,
      },
      2,
    ),
  ).toBe(
    "This desktop's monitor scale is not known to Desktop; drawn at 2×, zoom 100%. This is not a Hyprland session.",
  );
});

test("with the monitor unknown, Settings says the scale the human's Zoom draws at", () => {
  const unknown = { _tag: "Unknown", reason: "This is not a Hyprland session" } as const;
  expect(drawnSaid({ monitor: unknown, rendered: 2, zoom: 0.8, preference: 0.8 }, 1.6)).toBe(
    "This desktop's monitor scale is not known to Desktop; drawn at 1.6×, zoom 80%. This is not a Hyprland session.",
  );
});

test("Settings says when the view is not drawn at the scale the zoom should give it", () => {
  expect(drawnSaid(onFourK, 2)).toBe(
    "Drawn at 1.5× on DP-1 (3840×2160, Hyprland scale 1.5). Rendered at 2×, so zoom 75% × your 100%. Yet this window draws at 2×, so the zoom has not taken.",
  );
});

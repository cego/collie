import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { type BrowserWindow, Screen } from "../../core/platform";
import { Effect, Queue, Stream } from "effect";
import { type MonitorScale, monitorOf, zoomFor } from "../shared/scale";
import { output } from "./machine";

const monitorScale: (title: string) => Effect.Effect<MonitorScale> = (title) =>
  Bun.env.HYPRLAND_INSTANCE_SIGNATURE === undefined
    ? Effect.succeed({ _tag: "Unknown", reason: "This is not a Hyprland session" })
    : Effect.all([
        output(["hyprctl", "-j", "clients"]),
        output(["hyprctl", "-j", "monitors"]),
      ]).pipe(
        Effect.map(([clients, monitors]) => monitorOf(clients, monitors, process.pid, title)),
        Effect.orElseSucceed(() => {
          const returned: MonitorScale = {
            _tag: "Unknown",
            reason: "hyprctl could not be run",
          };
          return returned;
        }),
      );

const renderedScale = (window: BrowserWindow) => {
  const { x, y, width, height } = window.getFrame();
  const [cx, cy] = [x + width / 2, y + height / 2];
  const displays = Screen.getAllDisplays();
  const holding = Option.getOrUndefined(
    Arr.findFirst(
      displays,
      ({ bounds }) =>
        cx >= bounds.x &&
        cx < bounds.x + bounds.width &&
        cy >= bounds.y &&
        cy < bounds.y + bounds.height,
    ),
  );
  return (holding ?? Screen.getPrimaryDisplay()).scaleFactor || 1;
};

export const zoomWindow = (window: BrowserWindow, title: string, preference: number) =>
  Effect.map(monitorScale(title), (monitor) => {
    const rendered = renderedScale(window);
    const zoom = zoomFor(preference, monitor, rendered);
    window.setPageZoom(zoom);
    return { monitor, rendered, zoom, preference };
  });

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

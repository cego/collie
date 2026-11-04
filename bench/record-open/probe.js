// Injected into the view before it loads; the app knows nothing of it. For the card the
// harness expects, it times the click to the frame where the record's Flow shows every
// node, two frames more, and its controls enabled, then reads what was painted.
(() => {
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  const flowMap = () =>
    document.querySelector('[data-testid="flow"] [role="group"][aria-label="Flow"]');
  // Vue's production devtools hooks, on in the benchmark's build only.
  const flowOf = (map) => {
    let component = map?.__vueParentComponent;
    while (component != null && component.props?.flow === undefined) component = component.parent;
    return component?.props.flow ?? null;
  };
  const rowsOf = (flow) => [
    ...flow.lanes.map((lane) => lane.nodes),
    ...(flow.release === null ? [] : [flow.release]),
  ];
  const paintedOf = (map, flow) => {
    const rows = rowsOf(flow);
    return [...map.querySelectorAll(":scope > section")].map((section, r) => ({
      name: section.getAttribute("aria-label") ?? "",
      nodes: [...section.querySelectorAll(":scope > ol > li")].map((item, i) => {
        const node = rows[r]?.[i];
        return {
          name: item.querySelector("button[aria-pressed]")?.getAttribute("aria-label") ?? "",
          attempts: node === undefined ? -1 : node.attempts.length,
          wait: node?.wait ?? null,
          actions: [...item.querySelectorAll("button[aria-label]:not([aria-pressed])")].map(
            (button) => button.getAttribute("aria-label"),
          ),
        };
      }),
    }));
  };
  const marksOf = (card, start) =>
    Object.fromEntries(
      performance
        .getEntriesByType("mark")
        .filter((mark) => mark.detail?.card === card && mark.startTime >= start - 1)
        .map((mark) => [mark.name, mark.startTime]),
    );

  let watching = null;
  document.addEventListener(
    "click",
    (event) => {
      const card = event.target instanceof Element ? event.target.closest("[data-card]") : null;
      if (watching === null || watching.start !== null) return;
      if (card?.getAttribute("data-card") === watching.card) watching.start = event.timeStamp;
      else
        watching.waiting = `for the click on its card; one landed on ${
          card?.getAttribute("data-card") ??
          (event.target instanceof Element ? event.target.tagName.toLowerCase() : "nothing")
        }`;
    },
    true,
  );

  const follow = async (expected) => {
    // A Flow of any other Run shown after the click is a stale frame.
    let stale = false;
    for (;;) {
      await frame();
      if (watching !== expected) return null;
      if (expected.start === null) continue;
      const map = flowMap();
      const flow = flowOf(map);
      if (flow === null) {
        expected.waiting = "for a Flow";
        continue;
      }
      if (!flow.lanes.some((lane) => lane.run === expected.run)) {
        stale = true;
        expected.waiting = `on the Flow of ${flow.lanes.map((lane) => lane.run).join(", ")}`;
        continue;
      }
      const nodes = rowsOf(flow).reduce((sum, row) => sum + row.length, 0);
      const drawn = map.querySelectorAll("li button[aria-pressed]").length;
      if (nodes === 0 || drawn !== nodes) {
        expected.waiting = `on ${drawn} of ${nodes} Steps drawn`;
        continue;
      }
      await frame();
      await frame();
      expected.waiting = "on a disabled control";
      while ([...flowMap().querySelectorAll("li button")].some((button) => button.disabled))
        await frame();
      const end = performance.now();
      const shown = flowMap();
      return {
        card: expected.card,
        run: expected.run,
        ms: end - expected.start,
        stale,
        painted: paintedOf(shown, flowOf(shown)),
        marks: marksOf(expected.card, expected.start),
        start: expected.start,
        origin: performance.timeOrigin,
      };
    }
  };

  window.__bench = {
    /** Times the next click on `card`, whose record should show `run`'s Flow. */
    expect: (card, run) => {
      watching = { card, run, start: null, waiting: "for the click on its card" };
      window.__benchSample = follow(watching);
    },
    /** What the sample last waited on, said when it never paints. */
    waiting: () => watching?.waiting ?? null,
    /** What the open record paints now. */
    painted: () => paintedOf(flowMap(), flowOf(flowMap())),
    /** Whether the board is showing, with no record over it. */
    board: () =>
      document.querySelector("[data-card]") !== null &&
      document.querySelector('[data-testid="record"]') === null,
  };
})();

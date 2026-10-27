import { expect, test } from "bun:test";
import { IconUsageScanner } from "../desktop/node_modules/@nuxt/icon/dist/utils.mjs";
import { iconScan } from "../desktop/view/icon-scan";
import { desktopFlowAction, desktopLaneAction } from "../desktop/src/shared/flow-actions";
import { FlowAction, FlowLaneAction, type FlowRun } from "../src/board-model";
import { flowNode, mainFlow } from "./support/flow";

const bundled = (): Promise<ReadonlySet<string>> =>
  new IconUsageScanner(iconScan).scanFiles(`${import.meta.dir}/../desktop/view`);

const lane = mainFlow().lanes[1]!;
const node: FlowRun = flowNode("build", {
  agent: "builder-1",
  actions: [...FlowAction.literals],
  questions: [
    {
      name: "go",
      id: "choice-1",
      open: true,
      asked: null,
      answered: null,
      by: null,
      text: "Ship?",
      options: [],
    },
  ],
  proposal: { kind: "proposal", id: "p", hash: "h", text: "Review", actions: [] },
  url: "https://forge/mr/1",
});

test("every Flow and lane action's icon is compiled into Desktop's bundle", () => {
  const icons = [
    ...FlowAction.literals.map((kind) => desktopFlowAction(kind, node, lane, "vm-id", true)),
    ...FlowLaneAction.literals.map((kind) =>
      desktopLaneAction(kind, { ...lane, actions: [kind] }, "vm-id", true),
    ),
  ].map((action) => action?.icon.replace(/^i-lucide-/, "lucide:"));
  return bundled().then((scanned) =>
    expect(icons.filter((icon) => icon === undefined || !scanned.has(icon))).toEqual([]),
  );
});

import { Effect } from "effect";
import { RunRecords } from "./run-records";

const usualOf = (samples: ReadonlyArray<number>) => {
  if (samples.length < 3) return undefined;
  const values = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
};

export const stepTimesByWorkflow = RunRecords.use((records) => records.stepSamples).pipe(
  Effect.map((rows) => {
    const byStep = new Map<string, Map<string, Array<number>>>();
    for (const row of rows) {
      const steps = byStep.get(row.workflow) ?? new Map<string, Array<number>>();
      byStep.set(row.workflow, steps);
      steps.set(row.step, [...(steps.get(row.step) ?? []), row.ms]);
    }
    const byWorkflow = new Map<string, ReadonlyMap<string, number>>();
    for (const [workflow, steps] of byStep) {
      const usual = new Map<string, number>();
      for (const [step, samples] of steps) {
        const median = usualOf(samples);
        if (median !== undefined) usual.set(step, median);
      }
      byWorkflow.set(workflow, usual);
    }
    return byWorkflow;
  }),
);

export const usualStepTimes = (workflow: string) =>
  stepTimesByWorkflow.pipe(Effect.map((all) => all.get(workflow) ?? new Map<string, number>()));

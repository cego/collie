// The onboarding the dialog shows, wherever it was started from.

import type { Skippable } from "../../../src/shared/flock";

export const useOnboarding = () => {
  const job = useState<string | null>("onboarding-job", () => null);
  const { onboard, claudeLogin } = useActions();
  const shown = (started: string | null) => {
    if (started !== null) job.value = started;
  };
  /** Onboards, or repairs, the Machine a route reaches, and shows it; `skip` from then on. */
  const onboardOn = (profile: string, skip?: ReadonlyArray<Skippable>) =>
    onboard(profile, skip).then(shown);
  /** Logs Claude Code in there through this computer's browser, then onboards it again. */
  const loginOn = (profile: string) => claudeLogin(profile).then(shown);
  return { job, onboardOn, loginOn };
};

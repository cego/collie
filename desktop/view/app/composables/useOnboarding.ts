// The onboarding the dialog shows, wherever it was started from.

export const useOnboarding = () => {
  const job = useState<string | null>("onboarding-job", () => null);
  const { onboard, claudeLogin } = useActions();
  const shown = (started: string | null) => {
    if (started !== null) job.value = started;
  };
  /** Onboards, or repairs, the Machine a route reaches, and shows it. */
  const onboardOn = (profile: string) => onboard(profile).then(shown);
  /** Logs Claude Code in there through this computer's browser, then onboards it again. */
  const loginOn = (profile: string) => claudeLogin(profile).then(shown);
  return { job, onboardOn, loginOn };
};

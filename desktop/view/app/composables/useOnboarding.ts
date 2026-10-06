// The onboarding the dialog shows, wherever it was started from.

export const useOnboarding = () => {
  const job = useState<string | null>("onboarding-job", () => null);
  const { onboard } = useActions();
  /** Onboards, or repairs, the Machine a route reaches, and shows it. */
  const onboardOn = (profile: string) =>
    onboard(profile).then((started) => {
      if (started !== null) job.value = started;
    });
  return { job, onboardOn };
};

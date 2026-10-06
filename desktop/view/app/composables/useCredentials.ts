// Which credentials Desktop holds for every Machine, and whether the GitLab token is due.

import { AsyncResult, useAtomValue } from "@effect/atom-vue";
import { renewalDue } from "../../../../src/gitlab-token";
import { credentialsAtom } from "../flock";

export const useCredentials = () => {
  const held = useAtomValue(() => credentialsAtom);
  const { now } = useFlock();
  const credentials = computed(() => AsyncResult.getOrElse(held.value, () => null));
  return {
    credentials,
    /** When the GitLab token expires, where that is within the renewal window. */
    renewBy: computed(() => {
      const expires = credentials.value?.gitlab?.expires ?? null;
      return renewalDue(expires, now.value) ? expires : null;
    }),
  };
};

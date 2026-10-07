// A Run's evidence file as a URL the view can show, once asked for, for as long as the
// component lives.

import { mediaType } from "../../../src/shared/evidence";

export const useEvidenceUrl = (
  installation: string,
  runId: string,
  name: string,
  kind: "evidence" | "attachment" = "evidence",
) => {
  const { bytesOf } = useActions();
  const url = ref<string | null>(null);
  const state = ref<"idle" | "reading" | "failed">("idle");
  let gone = false;
  const load = () => {
    if (state.value === "reading" || url.value !== null) return;
    state.value = "reading";
    void bytesOf(installation, runId, `${kind}:${name}`).then((bytes) => {
      state.value = bytes === null ? "failed" : "idle";
      if (bytes === null || gone) return;
      const type = mediaType(name) ?? "application/octet-stream";
      url.value = URL.createObjectURL(new Blob([bytes], { type }));
    });
  };
  onBeforeUnmount(() => {
    gone = true;
    if (url.value !== null) URL.revokeObjectURL(url.value);
  });
  return { url, state, load };
};

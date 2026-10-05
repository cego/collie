// A Run's evidence file as a URL the view can show, for as long as the component lives.

const TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["ogv", "video/ogg"],
]);

export const useEvidenceUrl = (installation: string, runId: string, name: () => string) => {
  const { bytesOf } = useActions();
  const url = ref<string | null>(null);
  const failed = ref(false);
  const release = () => {
    if (url.value !== null) URL.revokeObjectURL(url.value);
    url.value = null;
  };
  watch(
    name,
    (now, _, onCleanup) => {
      let stale = false;
      onCleanup(() => (stale = true));
      release();
      void bytesOf(installation, runId, `evidence:${now}`).then((bytes) => {
        if (stale) return;
        failed.value = bytes === null;
        if (bytes === null) return;
        const type = TYPES.get(now.split(".").at(-1)!.toLowerCase()) ?? "application/octet-stream";
        url.value = URL.createObjectURL(new Blob([bytes], { type }));
      });
    },
    { immediate: true },
  );
  onBeforeUnmount(release);
  return { url, failed };
};

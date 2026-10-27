// The Flock chat's chosen width, kept in Desktop's settings; undefined is the start width.

import { chatWidthControl } from "../../../src/shared/chat-width";

export const useChatWidth = () => {
  const { desktopSettings, change } = useDesktopSettings();
  const toast = useToast();
  const chosen = ref<number | undefined>(desktopSettings.value.chatWidth);
  const dragging = ref<{ x: number; width: number } | null>(null);
  const control = chatWidthControl({ chosen, dragging }, (width) =>
    change({ chatWidth: width ?? null }).then((refused) => {
      if (refused !== null)
        toast.add({ title: `The chat's width was not kept: ${refused}`, color: "error" });
    }),
  );
  watch(() => desktopSettings.value.chatWidth, control.told);
  return { chosen, dragging, ...control };
};

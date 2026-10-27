// The Flow workspace's chosen sizes, shared by every record until Desktop quits; null is the default.

import { ref } from "vue";

const context = ref<number | null>(null);
const rail = ref<number | null>(null);

export const useFlowLayout = () => ({ context, rail });

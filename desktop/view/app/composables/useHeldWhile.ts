import { computed } from "vue";

/**
 * `value` as it last was while `held` was false. While `held`, `value` is not read, so nothing
 * it reads makes this, or what draws it, run again; once `held` ends it is read anew.
 */
export const useHeldWhile = <A>(value: () => A, held: () => boolean) => {
  let last: { readonly value: A } | undefined;
  return computed(() => {
    if (held() && last !== undefined) return last.value;
    last = { value: value() };
    return last.value;
  });
};

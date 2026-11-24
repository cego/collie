export const DELIVERY_TOKEN = "collie-delivery:";

export function carriedDelivery(prompt: string) {
  const returned: string | null = new RegExp(`${DELIVERY_TOKEN}(\\S+)`).exec(prompt)?.[1] ?? null;
  return returned;
}

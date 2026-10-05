<script setup lang="ts">
import { type OfferView, offerFields, offerInput } from "../../../../src/board-model";

const props = defineProps<{ installation: string; runId: string; chosen: string | null }>();
const emit = defineEmits<{ close: [] }>();
const { run, offersOf } = useActions();

const offers = ref<ReadonlyArray<OfferView> | null>(null);
const picked = ref<OfferView | null>(null);
const typed = ref<Record<string, string>>({});
const fields = computed(() => offerFields(picked.value?.arguments ?? null));

const make = async (offer: OfferView) => {
  emit("close");
  await run(props.installation, {
    _tag: "Invoke",
    runId: props.runId,
    offer: offer.id,
    input: offerInput(offer.arguments, typed.value),
  });
};

/** Picked, and made at once where it takes nothing; asked about otherwise. */
const pick = (offer: OfferView) => {
  picked.value = offer;
  typed.value = {};
  if (offer.unavailable === null && offerFields(offer.arguments).length === 0) void make(offer);
};

onMounted(async () => {
  // Asked again now: what a Run offers is its module's decision at this moment, not the card's.
  offers.value = await offersOf(props.installation, props.runId);
  if (offers.value === null) return emit("close");
  const named = offers.value.find((offer) => offer.id === props.chosen);
  if (named !== undefined) pick(named);
});
</script>

<template>
  <UModal
    :open="true"
    :title="picked === null ? `What next for ${runId}?` : picked.title"
    @update:open="(open: boolean) => !open && emit('close')"
  >
    <template #body>
      <p v-if="offers === null" class="text-muted">Asking what it offers…</p>
      <div v-else-if="picked === null" class="flex flex-col gap-2">
        <p v-if="offers.length === 0" class="text-muted">It offers nothing now.</p>
        <UButton
          v-for="offer in offers"
          :key="offer.id"
          :data-testid="`offer-${offer.id}`"
          color="neutral"
          variant="outline"
          :disabled="offer.unavailable !== null"
          :label="offer.unavailable === null ? offer.title : `${offer.title}: ${offer.unavailable}`"
          @click="pick(offer)"
        />
      </div>
      <p v-else-if="picked.unavailable !== null" class="text-muted">{{ picked.unavailable }}</p>
      <form v-else class="flex flex-col gap-3" @submit.prevent="make(picked)">
        <UFormField
          v-for="field in fields"
          :key="field.name"
          :label="field.name"
          :required="field.required"
        >
          <UInput v-model="typed[field.name]" class="w-full" :data-testid="`field-${field.name}`" />
        </UFormField>
        <UButton type="submit" class="self-end" :label="picked.title" data-testid="invoke" />
      </form>
    </template>
  </UModal>
</template>

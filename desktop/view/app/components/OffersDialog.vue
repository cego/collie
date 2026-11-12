<script setup lang="ts">
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import {
  asksBeforeTaking,
  type OfferField,
  type OfferView,
  offerChoices,
  offerFields,
  offerInput,
} from "../../../../src/board-model";
import { chosenOffer, invokeOf, offerKey } from "../../../src/shared/actions";
import { refusal } from "../../../src/shared/kept-records";

const props = defineProps<{
  installation: string;
  runId: string;
  /** The offer picked already, by its `offerKey`. */
  chosen: string | null;
  /** When the record was last confirmed; asked again on every try, after the dialog closes too. */
  asOf: () => number | null;
}>();
const emit = defineEmits<{ close: [] }>();
const { run, offersOf } = useActions();

const offers = ref<ReadonlyArray<OfferView> | null>(null);
const picked = ref<OfferView | null>(null);
const typed = ref<Record<string, string>>({});
const errors = ref<Readonly<Record<string, string>>>({});
const fields = computed(() => offerFields(picked.value?.arguments ?? null));
const refused = (offer: OfferView) => refusal(offer.unavailable, props.asOf());

const setEntry = (name: string, entry: string | undefined) => {
  typed.value =
    entry === undefined ? Rec.remove(typed.value, name) : { ...typed.value, [name]: entry };
};
const choiceKey = (field: OfferField) =>
  Option.match(
    Arr.findFirst(offerChoices(field), (one) => one.entry === typed.value[field.name]),
    { onNone: () => "unset", onSome: (one) => one.key },
  );
const choose = (field: OfferField, key: string) =>
  setEntry(
    field.name,
    Option.getOrUndefined(Arr.findFirst(offerChoices(field), (one) => one.key === key))?.entry,
  );

const make = (offer: OfferView) => {
  return Effect.runPromise(
    Effect.gen(function* () {
      if (refused(offer) !== null) return;
      const read = offerInput(offer.arguments, typed.value);
      if (read._tag === "Invalid") {
        errors.value = read.errors;
        return;
      }
      const { asOf } = props;
      emit("close");
      yield* Effect.promise(() =>
        Promise.resolve(
          run(
            props.installation,
            invokeOf(props.runId, offer, read.input),
            undefined,
            undefined,
            () => refusal(null, asOf()) ?? undefined,
          ),
        ),
      );
    }),
  );
};

/** Picked, and made at once where it neither takes anything nor asks first; asked about otherwise. */
const pick = (offer: OfferView) => {
  picked.value = offer;
  errors.value = {};
  typed.value = {};
  for (const field of offerFields(offer.arguments)) setEntry(field.name, field.initial);
  if (!asksBeforeTaking(offer)) void make(offer);
};

onMounted(() => {
  return Effect.runPromise(
    Effect.gen(function* () {
      // Asked again now: what a Run offers is its module's decision at this moment, not the card's.
      offers.value = yield* Effect.promise(() =>
        Promise.resolve(offersOf(props.installation, props.runId)),
      );
      if (offers.value === null) return emit("close");
      const named = chosenOffer(offers.value, props.chosen);
      if (named !== undefined) pick(named);
    }),
  );
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
          :key="offerKey(offer)"
          :data-testid="`offer-${offerKey(offer)}`"
          color="neutral"
          variant="outline"
          :disabled="refused(offer) !== null"
          :label="refused(offer) === null ? offer.title : `${offer.title}: ${refused(offer)}`"
          @click="pick(offer)"
        />
      </div>
      <p v-else-if="refused(picked) !== null" class="text-muted">{{ refused(picked) }}</p>
      <form v-else class="flex flex-col gap-3" novalidate @submit.prevent="make(picked)">
        <p v-if="picked.confirm" data-testid="confirm">{{ picked.confirm }}</p>
        <UFormField
          v-for="field in fields"
          :key="field.name"
          :name="field.name"
          :label="field.label"
          :description="field.help ?? undefined"
          :required="field.required"
          :error="errors[field.name]"
        >
          <UCheckbox
            v-if="field.control.kind === 'boolean' && field.required"
            :model-value="typed[field.name] === 'true'"
            :data-testid="`field-${field.name}`"
            @update:model-value="(on) => setEntry(field.name, on === true ? 'true' : 'false')"
          />
          <USelect
            v-else-if="field.control.kind === 'boolean' || field.control.kind === 'enum'"
            :model-value="choiceKey(field)"
            :items="[...offerChoices(field)]"
            value-key="key"
            label-key="label"
            class="w-full"
            :data-testid="`field-${field.name}`"
            @update:model-value="(key) => choose(field, String(key))"
          />
          <UTextarea
            v-else-if="field.control.kind === 'list' || field.control.kind === 'json'"
            :model-value="typed[field.name] ?? ''"
            :placeholder="field.control.kind === 'list' ? 'One per line' : 'JSON'"
            autoresize
            :rows="2"
            class="w-full"
            :data-testid="`field-${field.name}`"
            @update:model-value="(text: string) => setEntry(field.name, text)"
          />
          <UInput
            v-else
            :model-value="typed[field.name] ?? ''"
            :inputmode="field.control.kind === 'text' ? 'text' : 'decimal'"
            class="w-full"
            :data-testid="`field-${field.name}`"
            @update:model-value="(text: string | number) => setEntry(field.name, String(text))"
          />
        </UFormField>
        <UButton type="submit" class="self-end" :label="picked.title" data-testid="invoke" />
      </form>
    </template>
  </UModal>
</template>

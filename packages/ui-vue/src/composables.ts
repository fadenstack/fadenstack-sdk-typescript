import { onBeforeUnmount, onMounted, shallowRef, toRaw, toValue, triggerRef, watch, type MaybeRefOrGetter, type Ref, type ShallowRef } from "vue";

import type { Observable } from "@fadenstack/ui";
import { dismissOnOutside, stickToBottom } from "@fadenstack/ui-web";

/**
 * A view model as a ref that changes whenever the view model does: read it in a template or a `computed`, and the
 * view updates. Each view watches its own view model, so one change updates one view. Vue never wraps the view
 * model in a proxy (its private fields would break); `source` may be a prop's getter, `() => props.chat`.
 */
export function useViewModel<T extends Observable>(source: MaybeRefOrGetter<T>): ShallowRef<T> {
  const vm = shallowRef(toRaw(toValue(source))) as ShallowRef<T>;
  watch(() => toRaw(toValue(source)), (model, _previous, onCleanup) => {
    vm.value = model;
    onCleanup(model.subscribe(() => triggerRef(vm)));
  }, { immediate: true });
  return vm;
}

/**
 * Keeps a scroll box at the bottom while its content grows -- unless the user scrolled up to read; then it stays
 * where they are until they scroll back down.
 */
export function useStickToBottom(box: Readonly<Ref<HTMLElement | null | undefined>>): void {
  let stop: (() => void) | undefined;
  onMounted(() => {
    if (box.value) stop = stickToBottom(box.value).stop;
  });
  onBeforeUnmount(() => stop?.());
}

/** Closes a menu on a click outside its anchor (the menu and its button) or Escape, while `open` says it is open. */
export function useDismiss(open: () => boolean, close: () => void, anchor: Readonly<Ref<HTMLElement | null | undefined>>): void {
  watch([open, () => anchor.value] as const, ([isOpen, element], _previous, onCleanup) => {
    if (isOpen && element) onCleanup(dismissOnOutside(element, close));
  }, { immediate: true, flush: "post" });
}

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type { Observable } from "@fadenstack/ui";
import { dismissOnOutside, stickToBottom } from "@fadenstack/ui-web";

/** Re-renders when `vm` changes; returns it. Each view watches its own view model, so one change re-renders one view. */
export function useViewModel<T extends Observable>(vm: T): T {
  useSyncExternalStore(vm.subscribe, () => vm.version, () => vm.version);
  return vm;
}

/**
 * Keeps a scroll box at the bottom while its content grows -- unless the user scrolled up to read; then it stays
 * where they are until they scroll back down.
 */
export function useStickToBottom<T extends HTMLElement>(): { ref: React.RefObject<T | null>; stuck: React.RefObject<boolean> } {
  const ref = useRef<T | null>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const sticky = stickToBottom(box);
    const onScroll = () => {
      stuck.current = sticky.stuck;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      sticky.stop();
    };
  }, []);
  return { ref, stuck };
}

/** Closes a menu on a click outside it or Escape. */
export function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open || !ref.current) return;
    return dismissOnOutside(ref.current, close);
  }, [open, close, ref]);
}

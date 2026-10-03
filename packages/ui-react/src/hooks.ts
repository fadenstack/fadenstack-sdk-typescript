import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type { Observable } from "@fadenstack/ui";

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
    const onScroll = () => {
      stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (stuck.current) box.scrollTop = box.scrollHeight;
    });
    const content = box.firstElementChild;
    if (observer && content) observer.observe(content);
    return () => {
      box.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);
  return { ref, stuck };
}

/** Closes a menu on a click outside it or Escape. */
export function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

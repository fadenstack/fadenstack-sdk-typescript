/** The panel's browser behaviours, for any framework: a skin calls them from its own lifecycle. */

/**
 * Keeps a scroll box at the bottom while its content (its first child) grows -- unless the user scrolled up to
 * read; then it stays where they are until they scroll back down. Call `stop` when the box goes.
 */
export function stickToBottom(box: HTMLElement, threshold = 48): { readonly stuck: boolean; stop(): void } {
  let stuck = true;
  const onScroll = () => {
    stuck = box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  };
  box.addEventListener("scroll", onScroll, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
    if (stuck) box.scrollTop = box.scrollHeight;
  });
  const content = box.firstElementChild;
  if (observer && content) observer.observe(content);
  return {
    get stuck() {
      return stuck;
    },
    stop() {
      box.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    },
  };
}

/** Calls `close` on a press outside `anchor` (a menu and its button) or on Escape. Returns the stop. */
export function dismissOnOutside(anchor: HTMLElement, close: () => void): () => void {
  const onPointer = (e: PointerEvent) => {
    if (!anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  anchor.ownerDocument.addEventListener("pointerdown", onPointer);
  anchor.ownerDocument.addEventListener("keydown", onKey);
  return () => {
    anchor.ownerDocument.removeEventListener("pointerdown", onPointer);
    anchor.ownerDocument.removeEventListener("keydown", onKey);
  };
}

/** Grows a text box with its text, up to a third of the window (at least 120 px). */
export function fitToContent(box: HTMLTextAreaElement): void {
  const view = box.ownerDocument.defaultView;
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, Math.max(120, (view?.innerHeight ?? 360) / 3))}px`;
}

/** Focuses a text box with the caret after its text (after "Edit", or the host attached something). */
export function focusAtEnd(box: HTMLTextAreaElement): void {
  box.focus();
  const end = box.value.length;
  box.setSelectionRange(end, end);
}

/**
 * What a key in the composer does: Enter sends (Shift+Enter is a new line, and an input method that is still
 * composing keeps its Enter), Escape stops the running answer.
 */
export function composerKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">, busy: boolean): "send" | "stop" | undefined {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) return "send";
  if (e.key === "Escape" && busy) return "stop";
  return undefined;
}

/** How long a copy button shows its tick. */
export const COPIED_MS = 1500;

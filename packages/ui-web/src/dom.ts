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

/** What a key in the composer does (`composerKey`). */
export type ComposerAction = "send" | "stop" | "pick" | "next" | "previous" | "close";

/**
 * What a key in the composer does: Enter sends (Shift+Enter is a new line, and an input method that is still
 * composing keeps its Enter), Escape stops the running answer. While the skill picker is open (`pickerOpen`), the
 * arrows move in it, Enter and Tab pick, and Escape closes it.
 */
export function composerKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">, busy: boolean, pickerOpen = false): ComposerAction | undefined {
  if (pickerOpen && !e.isComposing) {
    if (e.key === "ArrowDown") return "next";
    if (e.key === "ArrowUp") return "previous";
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") return "pick";
    if (e.key === "Escape") return "close";
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) return "send";
  if (e.key === "Escape" && busy) return "stop";
  return undefined;
}

/** The pictures among pasted or dropped files. */
export function picturesIn(transfer: DataTransfer | null | undefined): File[] {
  return Array.from(transfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** A picture made ready for a message: a `data:` URL, and its size in pixels. */
export interface ReadPicture {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * A picture as a message takes it: at most `maxSide` pixels on its longer side (models scale larger ones down
 * anyway, and the transcript keeps it), as JPEG on white (transparent parts of a screenshot stay readable).
 * Throws when the browser cannot read it as a picture.
 */
export async function readPicture(picture: Blob, options: { maxSide?: number; quality?: number } = {}): Promise<ReadPicture> {
  const maxSide = options.maxSide ?? 1600;
  const bitmap = await createImageBitmap(picture);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas to draw the picture on.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/jpeg", options.quality ?? 0.85), width, height };
  } finally {
    bitmap.close();
  }
}

/** How long a copy button shows its tick. */
export const COPIED_MS = 1500;

import { isPicture, type MessageAttachment } from "@fadenstack/agents";

import { Observable } from "./observable.js";

export interface AttachmentOptions {
  title: string;
  /** A second line on the chip: its kind or where it is from. */
  subtitle?: string;
  /** Reads the content when the message is sent (so "the selection" is what is selected then). */
  resolve: (signal: AbortSignal) => Promise<MessageAttachment | undefined>;
  /**
   * Offered by the host (the current page, the selection): it stays between messages until the host replaces
   * it, and the user can switch it off.
   */
  implicit?: boolean;
  /** For an implicit chip: whether it starts switched on. Default on. */
  included?: boolean;
  /** A picture's `data:` URL: the chip shows it small. */
  image?: string;
}

/**
 * Context waiting in the composer to go with the next message: a chip the user can remove. An implicit chip
 * (as Copilot offers the current file) stays between messages and can be switched off.
 */
export class AttachmentViewModel extends Observable {
  readonly key = `a${++counter}`;
  readonly implicit: boolean;
  /** A picture's `data:` URL, shown small on the chip. */
  readonly image: string | undefined;
  readonly #resolve: AttachmentOptions["resolve"];
  #title: string;
  #subtitle: string | undefined;
  #included: boolean;

  constructor(options: AttachmentOptions) {
    super();
    this.#title = options.title;
    this.#subtitle = options.subtitle;
    this.#resolve = options.resolve;
    this.implicit = options.implicit ?? false;
    this.#included = options.included ?? true;
    this.image = options.image;
  }

  /** An attachment whose content is already known. */
  static fromContent(attachment: MessageAttachment): AttachmentViewModel {
    const options: AttachmentOptions = { title: attachment.title, resolve: () => Promise.resolve(attachment) };
    if (attachment.kind) options.subtitle = attachment.kind;
    if (isPicture(attachment)) options.image = attachment.content;
    return new AttachmentViewModel(options);
  }

  get title(): string {
    return this.#title;
  }

  get subtitle(): string | undefined {
    return this.#subtitle;
  }

  /** For an implicit chip: whether it goes with the next message. */
  get included(): boolean {
    return this.#included;
  }

  /** Whether it goes with the next message. */
  get sends(): boolean {
    return !this.implicit || this.#included;
  }

  toggle(): void {
    if (!this.implicit) return;
    this.#included = !this.#included;
    this.notify();
  }

  /** Changes what the chip says (the host's selection moved). */
  update(title: string, subtitle?: string): void {
    this.#title = title;
    this.#subtitle = subtitle;
    this.notify();
  }

  resolve(signal: AbortSignal): Promise<MessageAttachment | undefined> {
    return this.#resolve(signal);
  }
}

let counter = 0;

/** What a sent message had attached, as shown under it. */
export interface AttachmentChip {
  title: string;
  subtitle: string | undefined;
  /** A picture: its `data:` URL, shown small. */
  image?: string;
  /** A skill the user picked for the message (the chip shows its name). */
  skill?: boolean;
}

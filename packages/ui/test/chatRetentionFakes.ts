import { chatRetentionState, type ChatRetentionChoice, type ChatRetentionState } from "@fadenstack/agents";
import type { ChatRetentionSource } from "@fadenstack/ui";

// The states the setting for old chats shows, and a source that keeps what was saved: for the view model's and the skins' tests.

export const STATES = {
  person: chatRetentionState("person", true, 90, 50),
  "person-off": chatRetentionState("person", false, 90, 50),
  organisation: chatRetentionState("organisation", true, 14, 30, true),
  "organisation-none": chatRetentionState("organisation", true, 90, 50, false),
  policy: chatRetentionState("machinePolicy", true, 30, 100),
} as const satisfies Record<string, ChatRetentionState>;

/** A state to show, and what was saved. */
export class FakeSource implements ChatRetentionSource {
  state: ChatRetentionState;
  readonly saved: ChatRetentionChoice[] = [];

  constructor(state: ChatRetentionState) {
    this.state = state;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  set(choice: ChatRetentionChoice): Promise<ChatRetentionState> {
    if (this.state.canChange) {
      this.saved.push(choice);
      this.state = chatRetentionState("person", choice.autoDelete, choice.maxAgeDays, choice.maxSessions);
    }
    return Promise.resolve(this.state);
  }
}

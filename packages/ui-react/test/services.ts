import { MemoryClipboard, MemoryPreferenceStore, type ChatHostServices } from "@fadenstack/ui";

/**
 * The host's four services for a chat view model in a test (sdk/52 P4: they have no default): a clipboard and choices in
 * memory, and links and files that go nowhere. Spread it first, so a test's own service wins: `{ ...testServices(), clipboard }`.
 */
export function testServices(): ChatHostServices {
  return { clipboard: new MemoryClipboard(), openLink: () => undefined, saveFile: () => undefined, preferences: new MemoryPreferenceStore() };
}

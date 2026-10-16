import { describe, expect, it } from "vitest";

import { ContextBuilder, EntryTypes, MAX_HISTORY_PICTURES, TurnStatus, type TranscriptEntry } from "@fadenstack/agents";

const picture = (n: number) => `data:image/jpeg;base64,PIC${n}`;
let id = 0;

function entry(type: string, turnId: string, data: Record<string, unknown>, status: string | null = null): TranscriptEntry {
  return { id: `e${++id}`, parentId: null, timestamp: new Date(0).toISOString(), type, turnId, status, data };
}

/** A finished turn: the user's message (with these pictures) and an answer. */
function turn(turnId: string, text: string, pictures: number[] = []): TranscriptEntry[] {
  const attachments = pictures.map((n) => ({ title: `Picture ${n}`, content: picture(n), kind: "picture", media_type: "image/jpeg" }));
  return [
    entry(EntryTypes.userMessage, turnId, attachments.length ? { text, attachments } : { text }),
    entry(EntryTypes.assistantMessage, turnId, { text: `About ${text}`, tool_calls: [], origin: "model" }),
    entry(EntryTypes.turnEnd, turnId, {}, TurnStatus.ok),
  ];
}

describe("pictures in the history", () => {
  it("go as image parts before the text, the other attachments in the text", () => {
    const entries = [entry(EntryTypes.userMessage, "t1", {
      text: "Which is cheaper?",
      attachments: [
        { title: "Offer A", content: picture(1), kind: "screenshot", media_type: "image/jpeg" },
        { title: "Selection", content: "Offer B: 40 EUR", kind: "selection", media_type: "text/markdown" },
      ],
    })];
    const [user] = new ContextBuilder().build(entries);
    expect(user).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: picture(1) } },
        { type: "text", text: "<attachment title=\"Selection\" kind=\"selection\">\nOffer B: 40 EUR\n</attachment>\n\nWhich is cheaper?" },
      ],
    });
  });

  it("go with the newest messages only; older ones are named in their place", () => {
    const entries = [
      ...turn("t1", "first", [1, 2]),
      ...turn("t2", "second", [3, 4, 5]),
      ...turn("t3", "third", [6]),
    ];
    const messages = new ContextBuilder().build(entries);
    const sent = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === "image_url").map((p) => (p as { image_url: { url: string } }).image_url.url);
    expect(sent).toEqual([picture(3), picture(4), picture(5), picture(6)]);
    expect(sent.length).toBeLessThanOrEqual(MAX_HISTORY_PICTURES);
    expect(messages[0]).toEqual({
      role: "user",
      content: "<attachment title=\"Picture 1\" kind=\"picture\">\n[A picture the user attached earlier; it is not sent again.]\n</attachment>\n\n" +
        "<attachment title=\"Picture 2\" kind=\"picture\">\n[A picture the user attached earlier; it is not sent again.]\n</attachment>\n\nfirst",
    });
  });

  it("keep the newest message's pictures even when it has more than the history may carry", () => {
    const pictures = Array.from({ length: MAX_HISTORY_PICTURES + 2 }, (_, i) => i + 1);
    const messages = new ContextBuilder().build([...turn("t1", "old", [99]), ...turn("t2", "many", pictures)]);
    const parts = messages.at(-2)!.content as { type: string }[];
    expect(parts.filter((p) => p.type === "image_url").length).toBe(pictures.length);
    expect(typeof messages[0]!.content).toBe("string");
  });

  it("merge with a message before them that has none (a turn whose answer was refused)", () => {
    const entries = [
      entry(EntryTypes.userMessage, "t1", { text: "first" }),
      entry(EntryTypes.turnEnd, "t1", {}, TurnStatus.responseBlocked),
      entry(EntryTypes.userMessage, "t2", { text: "look", attachments: [{ title: "P", content: picture(1), media_type: "image/png" }] }),
    ];
    const [user] = new ContextBuilder().build(entries);
    expect(user).toEqual({
      role: "user",
      content: [{ type: "text", text: "first" }, { type: "image_url", image_url: { url: picture(1) } }, { type: "text", text: "look" }],
    });
  });

  it("are left out with a turn the app closed on (no end), unless it is the one running", () => {
    const cut = [
      entry(EntryTypes.userMessage, "t1", { text: "compare", attachments: [{ title: "P", content: picture(1), media_type: "image/png" }] }),
      entry(EntryTypes.assistantMessage, "t1", { text: "", tool_calls: [{ id: "c1", name: "read_context", arguments: "{}" }], origin: "model" }),
    ];
    const running = new ContextBuilder().build(cut);
    expect(running.map((m) => m.role)).toEqual(["user", "assistant"]);
    const later = new ContextBuilder().build([...cut, entry(EntryTypes.userMessage, "t2", { text: "again" })]);
    expect(later).toEqual([{ role: "user", content: "again" }]);
  });

  it("are left out of a message whose turn failed, with the rest of it", () => {
    const entries = [
      entry(EntryTypes.userMessage, "t1", { text: "broken", attachments: [{ title: "P", content: picture(1), media_type: "image/png" }] }),
      entry(EntryTypes.turnEnd, "t1", {}, TurnStatus.error),
      ...turn("t2", "next"),
    ];
    expect(new ContextBuilder().build(entries).every((m) => typeof m.content === "string")).toBe(true);
  });
});

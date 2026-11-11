// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalPart, PendingApproval, MemoryClipboard, englishStrings, type PartContext } from "@fadenstack/ui";
import { ApprovalDecision, EntryTypes, type ApprovalRequest, type TranscriptEntry } from "@fadenstack/agents";
import { TurnViewModel } from "../../ui/src/turn.js";
import { buildTurn } from "../../ui/src/transcriptTurns.js";
import { ApprovalView as ReactApproval } from "../../ui-react/src/Parts.js";
import VueApproval from "../src/parts/ApprovalView.vue";

const wrappers: VueWrapper[] = [];
afterEach(() => { cleanup(); for (const wrapper of wrappers) wrapper.unmount(); wrappers.length = 0; });
const context: PartContext = { strings: englishStrings, clipboard: new MemoryClipboard(), locale: "en", previewLength: 2000, now: () => new Date() };
const request: ApprovalRequest = { callId: "call", toolName: "write_note", toolClass: "write", source: "host", reason: "Review",
  arguments: { target: "selected note" }, grantDurations: [15, 30].map(minutes => minutes * 60_000) };
function fixture(change: Partial<ApprovalRequest> = {}) {
  const pending = new PendingApproval({ ...request, ...change }, new AbortController().signal);
  const turn = new TurnViewModel(context, undefined, "Write the note", new Date());
  turn.addApproval(pending);
  const part = turn.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart)!;
  const react = render(createElement(ReactApproval, { part, strings: englishStrings }));
  const vue = mount(VueApproval, { props: { part, strings: englishStrings }, attachTo: document.body });
  wrappers.push(vue);
  return { pending, part, turn, react, vue };
}

describe("server-confirmed time grants in both shared skins", () => {
  it("renders the offered durations and scope meaning in Vue and React", () => {
    const s = fixture();
    expect(s.vue.text()).toContain("Allow for 15 min");
    expect(within(s.react.container).getByText("Allow for 30 min")).toBeTruthy();
    expect(s.vue.text()).toContain("in your chats on this device");
    expect(s.part.timeGrantChoices.map(c => c.minutes)).toEqual([15, 30]);
  });

  it("keeps a chosen grant unconfirmed until the SDK supplies the server's actual narrowed duration", async () => {
    const s = fixture();
    fireEvent.click(within(s.react.container).getByText("Allow for 30 min"));
    expect(await s.pending.decision).toEqual({ approved: true, forTime: 30 * 60_000 });
    await flushPromises();
    expect(s.part.state).toBe("confirming");
    expect(s.vue.text()).toContain("Confirming permission with the server");
    expect(s.vue.text()).not.toContain("Server confirmed");
    s.turn.approvalDecided(request, ApprovalDecision.approveFor(15 * 60_000));
    await flushPromises();
    expect(s.part.stateText).toBe("Server confirmed up to 15 min");
    expect(s.vue.text()).toContain("Server confirmed up to 15 min");
  });

  it("a failed grant may acknowledge only the individually allowed call", async () => {
    const s = fixture();
    s.part.allowForTime(30);
    s.turn.approvalDecided(request, ApprovalDecision.approve());
    await flushPromises();
    expect(s.part.state).toBe("approved");
    expect(s.part.stateText).toBe("Allowed");
    expect(s.vue.text()).not.toContain("Server confirmed");
  });

  it("Stop settles a confirming card and rejects an unoffered duration", () => {
    const s = fixture();
    s.part.allowForTime(120);
    expect(s.pending.isResolved).toBe(false);
    s.part.allowForTime(15);
    expect(s.part.state).toBe("confirming");
    s.turn.stop();
    expect(s.part.isUnsettled).toBe(false);
    expect(s.part.state).toBe("expired");
    expect(s.part.stateText).toBe("Stopped");
  });

  it.each([{ toolClass: "destructive" as const }, { requiredByRule: true }, { toolClass: "unknown" as const }])(
    "never offers time for an individual/floor action despite malformed UI input", change => {
      const s = fixture(change);
      expect(s.part.timeGrantChoices).toEqual([]);
      expect(s.vue.text()).not.toContain("Allow for 15 min");
    });

  it("restores the actual confirmation from the journal without offering a new permission", () => {
    const entries: TranscriptEntry[] = [{ id: "one", parentId: null, timestamp: new Date().toISOString(), turnId: "turn", status: null,
      type: EntryTypes.approvalDecision, data: { call_id: "call", name: "write_note", asked: true, approved: true, scope: "grant", minutes: 15 } }];
    const restored = buildTurn(entries, context, undefined);
    const part = restored.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart)!;
    expect(part.stateText).toBe("Server confirmed up to 15 min");
    expect(part.isPending).toBe(false);
    expect(part.timeGrantChoices).toEqual([]);
  });
});

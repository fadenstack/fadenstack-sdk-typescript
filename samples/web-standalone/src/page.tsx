import { useState, useSyncExternalStore, type ReactElement } from "react";

import type { FadenstackAgent } from "@fadenstack/agents";
import type { AgentChatViewModel, MyDataSettingsViewModel, StopEverythingViewModel } from "@fadenstack/ui";
import { ChatPanel, MyDataSettings, StopEverythingButton } from "@fadenstack/ui-react";

import type { Notes } from "./sample.js";

/** What a connected page holds: the agent, its chat, "Stop everything" and the "Your data" control. */
export interface Running {
  agent: FadenstackAgent;
  chat: AgentChatViewModel;
  stop: StopEverythingViewModel;
  myData: MyDataSettingsViewModel;
}

/**
 * The page: the chat panel with "Stop everything" in the header, the notes beside it, and the drawer with "Your data in this browser".
 * The drawer opens from an entry in the panel's own settings menu (`settingsExtra`), so the header has one control named "Settings".
 */
export function Page({ running, notes }: { running: Running; notes: Notes }): ReactElement {
  const [drawer, setDrawer] = useState(false);
  const items = useSyncExternalStore(notes.subscribe, notes.getSnapshot);
  const s = running.chat.strings;
  const header = <StopEverythingButton stop={running.stop} />;
  const openDrawer = (): void => {
    running.chat.setSettingsOpen(false); // the menu closes; the drawer takes over
    setDrawer(true);
  };
  const entry = (
    <button type="button" role="menuitem" aria-haspopup="dialog" className="fdn-menu-item" onClick={openDrawer}>
      <span className="fdn-menu-check" />
      <span className="fdn-menu-label">{s.myDataTitle}</span>
    </button>
  );
  return (
    <div style={{ display: "flex", height: "100vh" }} onKeyDown={(e) => { if (e.key === "Escape" && drawer) setDrawer(false); }}>
      <div style={{ flex: "1 1 0", minWidth: 0 }}>
        <ChatPanel chat={running.chat} headerExtra={header} settingsExtra={entry} />
      </div>
      <aside style={{ width: 260, padding: 12, overflow: "auto", borderInlineStart: "1px solid var(--fdn-border, #8884)" }} aria-label="Notes">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Notes</h2>
        {items.length === 0 ? <p>No notes yet. Ask the assistant to save one.</p> : (
          <ul>{items.map((note, i) => <li key={i} dir="auto">{note}</li>)}</ul>
        )}
      </aside>
      {drawer && (
        <aside role="dialog" aria-label={s.myDataTitle} style={{ width: 340, padding: 12, overflow: "auto", borderInlineStart: "1px solid var(--fdn-border, #8884)" }}>
          <button type="button" className="fdn-button" onClick={() => setDrawer(false)}>{s.close}</button>
          <MyDataSettings settings={running.myData} />
        </aside>
      )}
    </div>
  );
}

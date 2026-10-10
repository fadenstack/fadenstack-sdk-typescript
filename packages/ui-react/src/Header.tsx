import { useCallback, useRef, type ReactElement, type ReactNode } from "react";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { useDismiss, useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/** The panel's top bar: the agent, the tool mode, the history, a new chat, and the host's own buttons. */
export function ChatHeader({ chat, extra }: { chat: AgentChatViewModel; extra?: ReactNode }): ReactElement {
  useViewModel(chat);
  const s = chat.strings;
  return (
    <header className="fdn-header">
      <div className="fdn-header-title" title={chat.title}>{chat.title}</div>
      <ModeMenu chat={chat} />
      <HistoryMenu chat={chat} />
      <button type="button" className="fdn-icon-button" title={s.newChat} aria-label={s.newChat} disabled={!chat.isReady || chat.isBusy}
        onClick={() => chat.newChat()}>
        <Icon name="plus" />
      </button>
      {extra}
    </header>
  );
}

function ModeMenu({ chat }: { chat: AgentChatViewModel }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => chat.setModeMenuOpen(false), [chat]);
  useDismiss(chat.isModeMenuOpen, close, ref);
  const current = chat.toolModes.find((o) => o.mode === chat.toolMode);
  return (
    <div className="fdn-menu-anchor" ref={ref}>
      <button type="button" className="fdn-mode-button" aria-haspopup="menu" aria-expanded={chat.isModeMenuOpen}
        aria-label={`${chat.strings.toolMode}: ${current?.label ?? ""}`}
        title={`${chat.strings.toolMode}: ${chat.toolModeHint}`} disabled={!chat.isReady}
        onClick={() => chat.setModeMenuOpen(!chat.isModeMenuOpen)}>
        <Icon name="tool" size={14} />
        <span>{current?.label}</span>
        <Icon name="chevron" size={14} />
      </button>
      {chat.isModeMenuOpen && (
        <div className="fdn-menu" role="menu" aria-label={chat.strings.toolMode}>
          {chat.toolModes.map((o) => (
            <button key={o.mode} type="button" role="menuitemradio" aria-checked={o.mode === chat.toolMode} disabled={!o.available}
              className="fdn-menu-item" onClick={() => chat.selectToolMode(o.mode)}>
              <span className="fdn-menu-check">{o.mode === chat.toolMode && <Icon name="check" size={14} />}</span>
              <span>
                <span className="fdn-menu-label">{o.label}</span>
                <span className="fdn-menu-description">{o.description}</span>
              </span>
            </button>
          ))}
          {chat.toolModeHint !== chat.strings.modes[chat.toolMode].description && (
            <div className="fdn-menu-note">{chat.toolModeHint}</div>
          )}
          <button type="button" role="menuitem" className="fdn-menu-item" onClick={() => void chat.resetApprovals()}>
            <span className="fdn-menu-check" />
            <span className="fdn-menu-label">{chat.strings.resetApprovals}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryMenu({ chat }: { chat: AgentChatViewModel }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => chat.setHistoryOpen(false), [chat]);
  useDismiss(chat.isHistoryOpen, close, ref);
  const s = chat.strings;
  return (
    <div className="fdn-menu-anchor" ref={ref}>
      <button type="button" className="fdn-icon-button" title={s.history} aria-label={s.history} aria-haspopup="menu"
        aria-expanded={chat.isHistoryOpen} disabled={!chat.isReady} onClick={() => void chat.toggleHistory()}>
        <Icon name="history" />
      </button>
      {chat.isHistoryOpen && (
        <div className="fdn-menu fdn-history" role="menu" aria-label={s.history}>
          {chat.sessions.length === 0 && <div className="fdn-menu-note">{s.noHistory}</div>}
          {chat.sessions.map((session) => (
            <div key={session.id} className={`fdn-history-item${session.isCurrent ? " fdn-current" : ""}`}>
              <button type="button" role="menuitem" className="fdn-history-open" disabled={chat.isBusy}
                onClick={() => void chat.openSession(session.id)}>
                <span className="fdn-history-title">{session.title}</span>
                <span className="fdn-history-when">{session.whenText}</span>
              </button>
              <button type="button" className="fdn-icon-button fdn-small" title={s.deleteSession} aria-label={`${s.deleteSession}: ${session.title}`}
                disabled={chat.isBusy && session.isCurrent} onClick={() => void chat.deleteSession(session.id)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

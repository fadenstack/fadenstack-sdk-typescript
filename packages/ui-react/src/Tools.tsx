import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";

import type { AgentChatViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/**
 * Tools, below the settings' gear: what the agent can use, read only. "In this app" lists the app's own tools with what each
 * does to things; "From your organisation's server" lists the server's tools by MCP server, each with whether it is available.
 * Descriptions are plain text, whatever a server wrote. It takes the focus when it opens; `onClose(true)` gives it back to the gear.
 */
export function ToolsPanel({ chat, onClose }: { chat: AgentChatViewModel; onClose: (returnFocus: boolean) => void }): ReactElement {
  const tools = useViewModel(chat.tools);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  const s = chat.strings;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose(true);
  };
  const app = tools.hostTools;
  return (
    <div className="fdn-menu fdn-tools" role="dialog" aria-label={s.tools} aria-busy={tools.isLoading} onKeyDown={onKeyDown}>
      <div className="fdn-about-head">
        <span className="fdn-about-title">{s.tools}</span>
        <button ref={closeButton} type="button" className="fdn-icon-button fdn-small" title={s.close} aria-label={s.close} onClick={() => onClose(true)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="fdn-tools-section" role="group" aria-labelledby={`${tools.key}-app`}>
        <div className="fdn-menu-heading" id={`${tools.key}-app`}>{s.toolsInApp}</div>
        {app.length === 0 ? (
          <div className="fdn-menu-note">{s.toolsNoneInApp}</div>
        ) : (
          <ul className="fdn-tools-list">
            {app.map((t) => (
              <li key={t.name} className="fdn-tools-row">
                <div className="fdn-tools-row-head">
                  <span className="fdn-tools-name" dir="auto">{t.name}</span>
                  <span className={`fdn-badge fdn-class-${t.toolClass}`}>{t.classLabel}</span>
                </div>
                {t.description && <div className="fdn-tools-desc" dir="auto">{t.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="fdn-tools-section" role="group" aria-labelledby={`${tools.key}-server`}>
        <div className="fdn-menu-heading" id={`${tools.key}-server`}>{s.toolsFromServer}</div>
        {tools.isLoading ? (
          <div className="fdn-menu-note" role="status">{s.toolsLoading}</div>
        ) : tools.failed ? (
          <div className="fdn-tools-failed">
            <div className="fdn-menu-note" role="alert">{s.toolsFailed}</div>
            <button type="button" className="fdn-button" onClick={() => void tools.load()}>{s.retry}</button>
          </div>
        ) : tools.isServerEmpty ? (
          <div className="fdn-menu-note" role="status">{s.toolsNone}</div>
        ) : (
          tools.serverGroups.map((group) => (
            <div key={group.server} className="fdn-tools-group" role="group" aria-label={group.server}>
              <div className="fdn-tools-server" dir="auto">{group.server}</div>
              <ul className="fdn-tools-list">
                {group.tools.map((t) => (
                  <li key={t.name} className="fdn-tools-row">
                    <div className="fdn-tools-row-head">
                      <span className="fdn-tools-name" dir="auto">{t.name}</span>
                      <span className={`fdn-badge fdn-tools-status fdn-tools-${t.status}`}>{t.statusLabel}</span>
                    </div>
                    {t.description && <div className="fdn-tools-desc" dir="auto">{t.description}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

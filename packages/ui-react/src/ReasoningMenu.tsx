import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { focusCurrentItem, menuKey } from "@fadenstack/ui-web";

import { useDismiss, useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/**
 * The thinking pill: how long the agent thinks before it answers (Auto, Off, and the levels up to the server's maximum), with
 * what each level means. Enter or Space opens the menu, the arrows move, Enter or Space picks, Escape closes; the focus returns
 * to the pill. .NET: the pill beside the tool mode in `ChatView`.
 */
export function ReasoningMenu({ chat }: { chat: AgentChatViewModel }): ReactElement {
  useViewModel(chat);
  const anchor = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = chat.isReasoningMenuOpen;
  const close = useCallback(() => chat.setReasoningMenuOpen(false), [chat]);
  useDismiss(open, close, anchor);
  useEffect(() => {
    if (open && menu.current) focusCurrentItem(menu.current);
  }, [open]);
  const s = chat.strings;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (menu.current && menuKey(menu.current, e) === "close") {
      close();
      pill.current?.focus();
    }
  };
  return (
    <div className="fdn-menu-anchor" ref={anchor}>
      <button ref={pill} type="button" className="fdn-mode-button fdn-reasoning-button" aria-haspopup="menu" aria-expanded={open}
        aria-label={chat.reasoningAutomationName} title={chat.reasoningToolTip} disabled={!chat.isReady}
        onClick={() => chat.setReasoningMenuOpen(!open)}>
        <Icon name="brain" size={14} />
        <span>{chat.reasoningPillText}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="fdn-menu fdn-reasoning" role="menu" aria-label={s.reasoningMenu} ref={menu} onKeyDown={onKeyDown}>
          <div className="fdn-menu-heading">{s.reasoningMenu}</div>
          {chat.reasoningOptions.map((o) => (
            <button key={o.level} type="button" role="menuitemradio" aria-checked={o.selected} className="fdn-menu-item"
              onClick={() => {
                void chat.selectReasoning(o.level);
                pill.current?.focus();
              }}>
              <span className="fdn-menu-check">{o.selected && <Icon name="check" size={14} />}</span>
              <span>
                <span className="fdn-menu-label">{o.label}</span>
                <span className="fdn-menu-description">{o.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

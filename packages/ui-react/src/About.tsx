import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import type { AgentChatViewModel, PanelLink } from "@fadenstack/ui";
import { COPIED_MS } from "@fadenstack/ui-web";

import { Icon } from "./icons.js";

/**
 * A link that opens in a new tab: without a way back to the panel or a Referer, its name saying so, and through the
 * chat's `openLink`, so a host can open it its own way.
 */
export function ExternalLink({ chat, link, className, iconSize = 12 }: { chat: AgentChatViewModel; link: PanelLink; className: string;
  iconSize?: number }): ReactElement {
  return (
    <a className={`${className} fdn-external`} href={link.href} target="_blank" rel="noopener noreferrer"
      aria-label={`${link.label} ${chat.strings.opensInNewTab}`}
      onClick={(e) => {
        e.preventDefault();
        chat.openLink(link.href);
      }}>
      {link.label}
      {iconSize > 0 && <Icon name="external" size={iconSize} />}
    </a>
  );
}

/**
 * Under the composer: that the answers come from an AI, and below it, on a line of its own, the muted Fadenstack
 * link (`branding`).
 */
export function NoticeLine({ chat }: { chat: AgentChatViewModel }): ReactElement | null {
  const notice = chat.strings.aiNotice;
  const link = chat.footerLink;
  if (!notice && !link) return null;
  return (
    <div className="fdn-footer">
      {notice && <p className="fdn-ai-notice" dir="auto">{notice}</p>}
      {link && (
        <p className="fdn-footer-brand">
          <ExternalLink chat={chat} link={link} className="fdn-footer-link" iconSize={0} />
        </p>
      )}
    </div>
  );
}

/**
 * About, below the settings' gear: the agent, the app it runs in, the SDK, the server, links, and "Copy details".
 * It takes the focus when it opens; `onClose(true)` gives it back to the gear.
 */
export function AboutPanel({ chat, onClose }: { chat: AgentChatViewModel; onClose: (returnFocus: boolean) => void }): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => clearTimeout(timer.current);
  }, []);
  const s = chat.strings;
  const about = chat.about;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose(true);
  };
  const copy = () => {
    void chat.copyAboutDetails().then((done) => {
      if (!done) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
  };
  return (
    <div className="fdn-menu fdn-about" role="dialog" aria-label={s.about} onKeyDown={onKeyDown}>
      <div className="fdn-about-head">
        <span className="fdn-about-title">{s.about}</span>
        <button ref={closeButton} type="button" className="fdn-icon-button fdn-small" title={s.close} aria-label={s.close}
          onClick={() => onClose(true)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {(about.agent || about.agentDetails.length > 0) && (
        <div className="fdn-about-agent">
          {about.agent && <span className="fdn-about-name" dir="auto">{about.agent}</span>}
          {about.agentDetails.map((line, i) => <span key={i} className="fdn-about-line">{line}</span>)}
        </div>
      )}
      <div className="fdn-about-environment">
        {about.environment.map((line, i) => <span key={i} className="fdn-about-line" dir="auto">{line}</span>)}
      </div>
      <div className="fdn-about-links">
        {about.links.map((link) => <ExternalLink key={link.href} chat={chat} link={link} className="fdn-about-link" />)}
      </div>
      <button type="button" className="fdn-button" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        <span>{copied ? s.copied : s.copyDetails}</span>
      </button>
    </div>
  );
}

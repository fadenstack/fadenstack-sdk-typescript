import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import type { AgentChatViewModel } from "@fadenstack/ui";
import { COPIED_MS } from "@fadenstack/ui-web";

import { ExternalLink } from "./About.js";
import { Icon } from "./icons.js";

/**
 * "Report a problem", a sheet like About below the settings' gear: to whom the report goes, and the lines the mail will contain, in a
 * read-only text region. It takes the focus when it opens; Escape and Close give it back to what opened it (About's button has gone with
 * About, so the gear then; `onClose(true)`). The SDK sends nothing: "Write mail" opens the host's mail link, "Copy details" copies the text.
 */
export function ReportProblemSheet({ chat, onClose }: { chat: AgentChatViewModel; onClose: (returnFocus: boolean) => void }): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => clearTimeout(timer.current);
  }, []);
  const view = chat.reportProblem;
  const close = () => {
    if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
      onClose(false);
      opener.focus({ preventScroll: true });
    } else {
      onClose(true);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  const copy = () => {
    void chat.copyReportDetails().then((done) => {
      if (!done) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
  };
  return (
    <div className="fdn-menu fdn-about fdn-report" role="dialog" aria-label={view.title} onKeyDown={onKeyDown}>
      <div className="fdn-about-head">
        <span className="fdn-about-title">{view.title}</span>
        <button ref={closeButton} type="button" className="fdn-icon-button fdn-small" title={view.close} aria-label={view.close} onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <p className="fdn-report-goes" dir="auto">{view.goesTo}</p>
      {view.help && (
        <div className="fdn-about-links">
          <ExternalLink chat={chat} link={view.help} className="fdn-about-link" />
        </div>
      )}
      <p className="fdn-about-line">{view.contains}</p>
      <textarea className="fdn-report-preview" readOnly spellCheck={false} rows={Math.min(14, view.preview.split("\n").length)}
        aria-label={view.contains} dir="auto" value={view.preview} />
      <p className="fdn-about-line">{view.noChats}</p>
      <div className="fdn-report-actions">
        {view.canWriteMail && (
          <button type="button" className="fdn-button" onClick={() => chat.writeReportMail()}>
            <Icon name="external" size={14} />
            <span>{view.writeMail}</span>
          </button>
        )}
        <button type="button" className="fdn-button" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={14} />
          <span>{copied ? chat.strings.copied : view.copyDetails}</span>
        </button>
      </div>
    </div>
  );
}

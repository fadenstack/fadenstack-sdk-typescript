import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";

import type { AgentChatViewModel, AttachmentViewModel, UiStrings } from "@fadenstack/ui";
import { composerKey, fitToContent, focusAtEnd } from "@fadenstack/ui-web";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/** The message box: context chips, the text, send or stop. Enter sends, Shift+Enter is a new line, Esc stops. */
export function Composer({ chat, accessory, placeholder }: {
  chat: AgentChatViewModel;
  /** The host's controls under the text (attach the page, the selection). */
  accessory?: ReactNode;
  placeholder?: string | undefined;
}): ReactElement {
  useViewModel(chat);
  const strings = chat.strings;
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => chat.onComposerFocus(() => {
    if (box.current) focusAtEnd(box.current);
  }), [chat]);

  // Grows with its text, up to a third of the panel.
  useLayoutEffect(() => {
    if (box.current) fitToContent(box.current);
  }, [chat.input]);

  const send = () => {
    if (chat.canSend) void chat.send();
  };

  return (
    <div className="fdn-composer">
      {chat.attachments.length > 0 && (
        <div className="fdn-chips">
          {chat.attachments.map((a) => <AttachmentChipView key={a.key} attachment={a} chat={chat} strings={strings} />)}
        </div>
      )}
      <textarea
        ref={box}
        rows={1}
        dir="auto"
        value={chat.input}
        placeholder={placeholder ?? strings.composerPlaceholder}
        aria-label={placeholder ?? strings.composerPlaceholder}
        onChange={(e) => chat.setInput(e.target.value)}
        onKeyDown={(e) => {
          const action = composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, chat.isBusy);
          if (!action) return;
          e.preventDefault();
          if (action === "send") send();
          else chat.stop();
        }}
      />
      <div className="fdn-composer-bar">
        <div className="fdn-composer-accessory">{accessory}</div>
        {chat.isBusy ? (
          <button type="button" className="fdn-send fdn-stop" aria-label={strings.stop} title={`${strings.stop} (Esc)`} onClick={() => chat.stop()}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="button" className="fdn-send" aria-label={strings.send} title={strings.send} disabled={!chat.canSend} onClick={send}>
            <Icon name="send" />
          </button>
        )}
      </div>
    </div>
  );
}

function AttachmentChipView({ attachment, chat, strings }: { attachment: AttachmentViewModel; chat: AgentChatViewModel; strings: UiStrings }): ReactElement {
  useViewModel(attachment);
  return (
    <span className={`fdn-chip${attachment.implicit && !attachment.included ? " fdn-chip-off" : ""}`}>
      {attachment.implicit ? (
        <button type="button" className="fdn-chip-toggle" aria-pressed={attachment.included} title={strings.includeAttachment}
          onClick={() => attachment.toggle()}>
          <Icon name="page" size={12} />
          <span className="fdn-chip-title" dir="auto">{attachment.title}</span>
          {attachment.subtitle && <span className="fdn-chip-sub">{attachment.subtitle}</span>}
        </button>
      ) : (
        <>
          <Icon name="page" size={12} />
          <span className="fdn-chip-title" dir="auto">{attachment.title}</span>
          {attachment.subtitle && <span className="fdn-chip-sub">{attachment.subtitle}</span>}
          <button type="button" className="fdn-chip-remove" aria-label={`${strings.removeAttachment} ${attachment.title}`}
            onClick={() => chat.removeAttachment(attachment)}>
            <Icon name="close" size={12} />
          </button>
        </>
      )}
    </span>
  );
}

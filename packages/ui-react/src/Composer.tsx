import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type DragEvent, type ReactElement, type ReactNode } from "react";

import type { AgentChatViewModel, AttachmentViewModel, SkillPickerViewModel, UiStrings } from "@fadenstack/ui";
import { composerKey, fitToContent, focusAtEnd, picturesIn, readPicture } from "@fadenstack/ui-web";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";

/**
 * The message box: context chips, the text, send or stop. Enter sends, Shift+Enter is a new line, Esc stops. `$`
 * opens the skills to pick for the message; a pasted or dropped picture goes with it, for a model that sees pictures.
 */
export function Composer({ chat, accessory, placeholder }: {
  chat: AgentChatViewModel;
  /** The host's controls under the text (attach the page, the selection). */
  accessory?: ReactNode;
  placeholder?: string | undefined;
}): ReactElement {
  useViewModel(chat);
  const picker = chat.skillPicker;
  useViewModel(picker);
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

  const addPictures = (files: readonly File[], pasted: boolean) => {
    for (const file of files) {
      void readPicture(file).then(
        (picture) => chat.attachPicture({ dataUrl: picture.dataUrl, ...(pasted ? {} : { title: file.name }) }),
        () => chat.pictureNotRead(file.name),
      );
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const pictures = picturesIn(e.clipboardData);
    if (pictures.length === 0) return; // text pastes as text
    e.preventDefault();
    addPictures(pictures, true);
  };
  const onDrop = (e: DragEvent) => {
    const pictures = picturesIn(e.dataTransfer);
    if (pictures.length === 0) return; // other files are the host's
    e.preventDefault();
    e.stopPropagation();
    addPictures(pictures, false);
  };

  const listId = `${picker.key}-list`;
  const open = picker.isOpen && chat.canPickSkills;

  return (
    <div className="fdn-composer" onDrop={onDrop}>
      {open && <SkillPicker picker={picker} strings={strings} listId={listId} />}
      {(chat.attachments.length > 0 || chat.pickedSkills.length > 0) && (
        <div className="fdn-chips">
          {chat.pickedSkills.map((s) => (
            <span key={s.slug} className="fdn-chip fdn-chip-skill" title={s.description || undefined}>
              <Icon name="sparkle" size={12} />
              <span className="fdn-chip-title" dir="auto">{s.name}</span>
              <span className="fdn-chip-sub">{strings.skill}</span>
              <button type="button" className="fdn-chip-remove" aria-label={`${strings.removeAttachment} ${s.name}`}
                onClick={() => chat.removeSkill(s.slug)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
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
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && picker.options.length > 0 ? `${picker.key}-${picker.activeIndex}` : undefined}
        onChange={(e) => chat.setInput(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          const action = composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, chat.isBusy, open);
          if (!action) return;
          e.preventDefault();
          if (action === "send") send();
          else if (action === "stop") chat.stop();
          else if (action === "next") picker.move(1);
          else if (action === "previous") picker.move(-1);
          else if (action === "pick") picker.pick();
          else picker.close();
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

/** The skills to pick from, above the composer, narrowed by what follows the `$`. */
function SkillPicker({ picker, strings, listId }: { picker: SkillPickerViewModel; strings: UiStrings; listId: string }): ReactElement {
  const options = picker.options;
  return (
    <div className="fdn-menu fdn-skill-picker">
      <span className="fdn-menu-heading" id={`${picker.key}-label`}>{strings.skills}</span>
      {picker.isLoading ? (
        <div className="fdn-menu-note" role="status">{strings.skillsLoading}</div>
      ) : picker.failed ? (
        <div className="fdn-menu-note" role="alert">{strings.skillsFailed}</div>
      ) : options.length === 0 ? (
        <div className="fdn-menu-note" role="status">{picker.hasSkills ? strings.noSkillMatches(picker.query) : strings.noSkills}</div>
      ) : null}
      <div className="fdn-skill-list" role="listbox" id={listId} aria-labelledby={`${picker.key}-label`}>
        {options.map((s, i) => (
          <div key={s.slug} id={`${picker.key}-${i}`} role="option" aria-selected={i === picker.activeIndex} className="fdn-menu-item fdn-skill-option"
            // Picked on press, before the text box loses the focus (and the caret its place).
            onMouseDown={(e) => {
              e.preventDefault();
              picker.pick(s);
            }}>
            <span className="fdn-menu-check"><Icon name="sparkle" size={14} /></span>
            <span>
              <span className="fdn-menu-label" dir="auto">{s.name}</span>
              {s.description && <span className="fdn-menu-description" dir="auto">{s.description}</span>}
            </span>
          </div>
        ))}
      </div>
      {options.length > 0 && <div className="fdn-menu-note fdn-skill-hint">{strings.skillPickerHint}</div>}
    </div>
  );
}

function ChipMark({ attachment }: { attachment: AttachmentViewModel }): ReactElement {
  return attachment.image ? <img className="fdn-chip-image" src={attachment.image} alt="" /> : <Icon name="page" size={12} />;
}

function AttachmentChipView({ attachment, chat, strings }: { attachment: AttachmentViewModel; chat: AgentChatViewModel; strings: UiStrings }): ReactElement {
  useViewModel(attachment);
  return (
    <span className={`fdn-chip${attachment.implicit && !attachment.included ? " fdn-chip-off" : ""}`}>
      {attachment.implicit ? (
        <button type="button" className="fdn-chip-toggle" aria-pressed={attachment.included} title={strings.includeAttachment}
          onClick={() => attachment.toggle()}>
          <ChipMark attachment={attachment} />
          <span className="fdn-chip-title" dir="auto">{attachment.title}</span>
          {attachment.subtitle && <span className="fdn-chip-sub">{attachment.subtitle}</span>}
        </button>
      ) : (
        <>
          <ChipMark attachment={attachment} />
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

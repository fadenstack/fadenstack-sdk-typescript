import { useId, useRef, type FormEvent, type ReactElement } from "react";

import type { ChatRetentionSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Actions, Alert, Button, Field, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface ChatRetentionSettingsProps extends SkillViewProps {
  /** The setting's view model (`new ChatRetentionSettingsViewModel({ agent })`). Call its `load()` once when the page opens. */
  settings: ChatRetentionSettingsViewModel;
}

/**
 * The setting for old chats, where an app keeps its settings: a switch for automatic deletion, the two limits (days, chats), Save and
 * Cancel. Where the organisation decides (governed) or the machine policy on this computer fixes it, the values are shown (or one
 * sentence) and cannot be changed. The texts are the view model's; the checks and the buttons are too. Parity with `@fadenstack/ui-vue`'s
 * `ChatRetentionSettings`; .NET: `ChatRetentionSettingsView` in both skins.
 */
export function ChatRetentionSettings(props: ChatRetentionSettingsProps): ReactElement {
  const vm = useViewModel(props.settings);
  const s = vm.strings;
  const id = useId();
  const column = useRef<HTMLDivElement>(null);
  useFirstFocus(column, [props.settings]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.save();
  };

  return (
    <Shell s={s} theme={props.theme} className={props.className} busy={false} columnRef={column}>
      <Title>{s.chatRetentionTitle}</Title>
      {vm.showNote && <p className="fdn-wizard-note" role="status" dir="auto">{vm.note}</p>}
      {vm.showControls && (
        <form className="fdn-wizard-form" onSubmit={submit} noValidate>
          <div className="fdn-wizard-check">
            <input id={`${id}-auto`} type="checkbox" role="switch" checked={vm.autoDelete} disabled={!vm.canEdit} aria-describedby={`${id}-hint`}
              data-wizard-focus="" onChange={(e) => { vm.autoDelete = e.target.checked; }} />
            <label htmlFor={`${id}-auto`} dir="auto">{s.chatRetentionAutoDelete}</label>
          </div>
          <p id={`${id}-hint`} className="fdn-wizard-note" dir="auto">{s.chatRetentionAutoDeleteHint}</p>

          <Field id={`${id}-days`} label={s.chatRetentionMaxAge}>
            <input id={`${id}-days`} type="text" inputMode="numeric" autoComplete="off" value={vm.maxAgeDaysText} disabled={!vm.limitsEnabled}
              aria-invalid={vm.hasDaysError || undefined} aria-describedby={vm.hasDaysError ? `${id}-days-error` : undefined}
              onChange={(e) => { vm.maxAgeDaysText = e.target.value; }} />
          </Field>
          {vm.hasDaysError && <Alert id={`${id}-days-error`}>{vm.daysError}</Alert>}

          <Field id={`${id}-chats`} label={s.chatRetentionMaxSessions}>
            <input id={`${id}-chats`} type="text" inputMode="numeric" autoComplete="off" value={vm.maxSessionsText} disabled={!vm.limitsEnabled}
              aria-invalid={vm.hasChatsError || undefined} aria-describedby={vm.hasChatsError ? `${id}-chats-error` : undefined}
              onChange={(e) => { vm.maxSessionsText = e.target.value; }} />
          </Field>
          {vm.hasChatsError && <Alert id={`${id}-chats-error`}>{vm.chatsError}</Alert>}

          {vm.canEdit && (
            <Actions>
              <Button primary submit disabled={!vm.canSave} label={s.chatRetentionSaveName}>{s.chatRetentionSave}</Button>
              <Button onClick={() => vm.cancel()} disabled={!vm.canCancel} label={s.chatRetentionCancelName}>{s.chatRetentionCancel}</Button>
            </Actions>
          )}
          <p className="fdn-skills-message" role="status" dir="auto">{vm.statusText}</p>
        </form>
      )}
    </Shell>
  );
}

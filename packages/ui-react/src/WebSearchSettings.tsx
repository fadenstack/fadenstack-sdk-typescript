import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import type { WebSearchChoice, WebSearchSettingsViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Actions, Alert, Button, Field, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface WebSearchSettingsProps extends SkillViewProps {
  /** The sheet's view model (`new WebSearchSettingsViewModel({ store })`); the app calls `retext()` when the language changes and `dispose()` when it is done. */
  settings: WebSearchSettingsViewModel;
}

/**
 * The web search settings as a view of its own (sdk/51 F06), for an app that has a Tools page of its own (the desktop): Off, Brave
 * with the person's own key, or a SearXNG address. The key is a password box that is never filled from the store; a kept key shows
 * as "saved" with Replace and Remove key. The same sheet opens inside `ToolsPage` on "In this app".
 */
export function WebSearchSettings(props: WebSearchSettingsProps): ReactElement {
  const vm = useViewModel(props.settings);
  const column = useRef<HTMLDivElement>(null);
  useFirstFocus(column, [], true);
  return (
    <Shell s={vm.strings} theme={props.theme} className={`fdn-websearch${props.className ? ` ${props.className}` : ""}`} busy={vm.isBusy} columnRef={column}>
      <WebSearchSheet sheet={props.settings} />
    </Shell>
  );
}

/** The sheet's body: the Tools page shows it in place of its list, `WebSearchSettings` in its own shell. */
export function WebSearchSheet({ sheet: model }: { sheet: WebSearchSettingsViewModel }): ReactElement {
  const sheet = useViewModel(model);
  const s = sheet.strings;
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void sheet.save();
  };
  const pick = (choice: WebSearchChoice) => () => { sheet.choice = choice; };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    sheet.cancel();
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <form className="fdn-tp-sheet" onSubmit={submit} onKeyDown={onKeyDown} noValidate aria-busy={sheet.isBusy}>
      <Title>{sheet.title}</Title>
      <p dir="auto">{s.webSearchIntro}</p>
      <fieldset>
        <legend dir="auto">{s.webSearchChoiceName}</legend>
        <div className="fdn-wizard-check">
          <input id={`${id}-off`} type="radio" name={`${id}-choice`} checked={sheet.isOff} onChange={pick("off")} data-wizard-focus="" aria-describedby={`${id}-off-help`} />
          <label htmlFor={`${id}-off`} dir="auto">{s.webSearchChoiceOff}</label>
        </div>
        <p id={`${id}-off-help`} className="fdn-tp-help" dir="auto">{s.webSearchOffHelp}</p>
        <div className="fdn-wizard-check">
          <input id={`${id}-brave`} type="radio" name={`${id}-choice`} checked={sheet.isBrave} onChange={pick("brave")} />
          <label htmlFor={`${id}-brave`} dir="auto">{s.webSearchChoiceBrave}</label>
        </div>
        <div className="fdn-wizard-check">
          <input id={`${id}-searxng`} type="radio" name={`${id}-choice`} checked={sheet.isSearxng} onChange={pick("searxng")} />
          <label htmlFor={`${id}-searxng`} dir="auto">{s.webSearchChoiceSearxng}</label>
        </div>
      </fieldset>

      {sheet.isBrave && (
        <>
          {sheet.keyIsKept ? (
            <div className="fdn-tp-row">
              <span className="fdn-tp-dots" role="img" aria-label={s.webSearchKeyKept}>{s.toolsValueSaved}</span>
              <span dir="auto">{s.webSearchKeyKept}</span>
              <Button quiet onClick={() => sheet.replaceKey()}>{s.webSearchKeyReplace}</Button>
              <Button quiet onClick={() => sheet.removeKey()}>{s.webSearchKeyRemove}</Button>
            </div>
          ) : (
            <>
              <Field id={`${id}-key`} label={s.webSearchKeyLabel}>
                <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} dir="ltr" value={sheet.key} aria-describedby={`${id}-key-help`}
                  onChange={(e) => { sheet.key = e.target.value; }} />
              </Field>
              {sheet.keyIsRemoved && <p className="fdn-tp-result" role="status" dir="auto">{s.webSearchKeyRemoved}</p>}
              {sheet.canRemoveKey && <Actions><Button quiet onClick={() => sheet.removeKey()}>{s.webSearchKeyRemove}</Button></Actions>}
            </>
          )}
          <p id={`${id}-key-help`} className="fdn-tp-help" dir="auto">{s.webSearchKeyHelp}</p>
        </>
      )}

      {sheet.isSearxng && (
        <>
          <Field id={`${id}-url`} label={s.webSearchUrlLabel}>
            <input id={`${id}-url`} type="text" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr" value={sheet.address} aria-describedby={`${id}-url-help`}
              aria-invalid={sheet.hasError ? true : undefined} onChange={(e) => { sheet.address = e.target.value; }} />
          </Field>
          <p id={`${id}-url-help`} className="fdn-tp-help" dir="auto">{s.webSearchUrlHelp}</p>
        </>
      )}

      {!sheet.isOff && <p className="fdn-tp-help" dir="auto">{sheet.keptWhereText}</p>}
      {!sheet.isOff && <p className="fdn-tp-help" dir="auto">{sheet.privacyText}</p>}
      {sheet.hasError && <Alert>{sheet.errorText}</Alert>}
      {sheet.hasSaved && <p className="fdn-tp-result" role="status" dir="auto">{sheet.savedText}</p>}
      <Actions>
        <Button primary submit disabled={sheet.isBusy}>{s.webSearchSave}</Button>
        <Button onClick={() => sheet.cancel()}>{s.webSearchCancel}</Button>
      </Actions>
    </form>
  );
}

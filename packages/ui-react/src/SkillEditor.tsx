import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import { type SkillResourceViewModel, type SkillEditorViewModel, type StringsSource, type UiStrings } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Markdown } from "./Markdown.js";
import { Actions, Alert, Ask, Button, Field, Issues, Shell, Title, defaultStrings, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface SkillEditorProps extends SkillViewProps {
  /** The editor's view model (new, edit, a bundled skill to read, or a draft's proposal). Closing it (Save, Cancel) is the app's: `onClosed`. */
  editor: SkillEditorViewModel;
}

/**
 * The skill editor (sdk/51 F04) in the wizard's column: the name and the description with the checks' words as you type, the instructions
 * with a Markdown preview (the chat's own rendering), the `faden.yaml` fields, the files, the checks, Save (on only when the view model
 * says so), Cancel and the Try panel. It only renders: every text is the app's `strings`, every command is called in the click's own
 * turn, and **nothing is saved but by Save** (or by confirming a replacement). A skill's text is untrusted: it is drawn as text and as
 * Markdown blocks, never as HTML.
 */
export function SkillEditor(props: SkillEditorProps): ReactElement {
  const { strings = defaultStrings } = props;
  const vm = useViewModel(props.editor);
  const column = useRef<HTMLDivElement>(null);
  return (
    <Shell s={strings()} theme={props.theme} className={props.className} busy={vm.isSaving} columnRef={column} onKeyDown={(e) => editorEscape(vm, e)}>
      <SkillEditorBody editor={props.editor} strings={strings} />
    </Shell>
  );
}

/** Escape says no to the replace question when it is open, else it is Cancel. */
export function editorEscape(vm: SkillEditorViewModel, e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (vm.needsReplaceConfirmation) vm.dismissReplace();
  else vm.cancel();
  e.preventDefault();
  e.stopPropagation();
}

/** The editor inside a shell (the library draws it in place of its list). */
export function SkillEditorBody({ editor, strings }: { editor: SkillEditorViewModel; strings: StringsSource }): ReactElement {
  const vm = useViewModel(editor);
  const s = strings();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const readOnly = vm.isReadOnly;
  const asking = vm.needsReplaceConfirmation;

  // The editor's first field takes the focus; the replace question's Cancel while it is open.
  useFirstFocus(root, [editor, asking]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.save(); // only the person's Save writes anything
  };

  const about = (subject: string) => vm.issues.filter((i) => i.subject === subject);
  const nameIssues = about("name");
  const descriptionIssues = about("description");
  const instructionsIssues = about("instructions");
  const invalid = (items: readonly { isError: boolean }[]) => (items.some((i) => i.isError) ? true : undefined);
  const failed = vm.message === s.skillSaveFailed;

  return (
    <div className="fdn-skills-editor" ref={root} aria-busy={vm.isSaving}>
      <Title>{vm.heading}</Title>
      {vm.isProposal && <p className="fdn-wizard-note" dir="auto">{vm.proposalNote}</p>}
      {vm.message && (failed ? <Alert>{vm.message}</Alert> : <p className="fdn-skills-message" role="status" dir="auto">{vm.message}</p>)}
      {asking && (
        <Ask id={`${id}-replace`} title={vm.replaceTitle} body={vm.replaceBody}>
          <Actions>
            <Button focus onClick={() => vm.dismissReplace()}>{s.skillCancel}</Button>
            <Button primary disabled={!vm.canConfirmReplace} onClick={() => void vm.confirmReplace()}>{s.skillReplace}</Button>
          </Actions>
        </Ask>
      )}

      <form id={`${id}-form`} className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-name`} label={s.skillName}>
          <input id={`${id}-name`} type="text" autoComplete="off" spellCheck={false} dir="ltr" value={vm.name} readOnly={readOnly}
            aria-invalid={invalid(nameIssues)} aria-describedby={nameIssues.length > 0 ? `${id}-name-issues` : undefined}
            data-wizard-focus={asking ? undefined : ""} onChange={(e) => { vm.name = e.target.value; }} />
        </Field>
        <Issues id={`${id}-name-issues`} items={nameIssues} />

        <Field id={`${id}-description`} label={s.skillDescription}>
          <textarea id={`${id}-description`} rows={3} dir="auto" value={vm.description} readOnly={readOnly}
            aria-invalid={invalid(descriptionIssues)} aria-describedby={descriptionIssues.length > 0 ? `${id}-description-issues` : undefined}
            onChange={(e) => { vm.description = e.target.value; }} />
        </Field>
        <Issues id={`${id}-description-issues`} items={descriptionIssues} />

        <div className="fdn-skills-head">
          <label htmlFor={`${id}-instructions`} dir="auto">{s.skillInstructions}</label>
          <div className="fdn-wizard-check">
            <input id={`${id}-preview`} type="checkbox" checked={vm.showPreview} onChange={(e) => { vm.showPreview = e.target.checked; }} />
            <label htmlFor={`${id}-preview`} dir="auto">{s.skillPreview}</label>
          </div>
        </div>
        <textarea id={`${id}-instructions`} className="fdn-skills-instructions" rows={10} dir="auto" spellCheck={false} value={vm.instructions}
          readOnly={readOnly} aria-invalid={invalid(instructionsIssues)}
          aria-describedby={instructionsIssues.length > 0 ? `${id}-instructions-issues` : undefined}
          onChange={(e) => { vm.instructions = e.target.value; }} />
        <Issues id={`${id}-instructions-issues`} items={instructionsIssues} />
        {vm.showPreview && (
          <div className="fdn-card fdn-skills-preview" role="region" aria-label={s.skillPreview}>
            <Markdown blocks={vm.previewBlocks} strings={s} />
          </div>
        )}

        <h3 dir="auto">{s.skillMatching}</h3>
        <Field id={`${id}-title`} label={s.skillTitleField}>
          <input id={`${id}-title`} type="text" autoComplete="off" dir="auto" value={vm.extensionTitle} readOnly={readOnly}
            onChange={(e) => { vm.extensionTitle = e.target.value; }} />
        </Field>
        <Field id={`${id}-keywords`} label={s.skillKeywords}>
          <input id={`${id}-keywords`} type="text" autoComplete="off" dir="auto" value={vm.keywordsText} readOnly={readOnly}
            onChange={(e) => { vm.keywordsText = e.target.value; }} />
        </Field>
        <Field id={`${id}-tags`} label={s.skillTags}>
          <input id={`${id}-tags`} type="text" autoComplete="off" dir="auto" value={vm.tagsText} readOnly={readOnly}
            onChange={(e) => { vm.tagsText = e.target.value; }} />
        </Field>
        <Field id={`${id}-filetypes`} label={s.skillFileTypes}>
          <input id={`${id}-filetypes`} type="text" autoComplete="off" dir="ltr" value={vm.fileTypesText} readOnly={readOnly}
            onChange={(e) => { vm.fileTypesText = e.target.value; }} />
        </Field>
        <Field id={`${id}-tools`} label={s.skillPreferredTools}>
          <input id={`${id}-tools`} type="text" autoComplete="off" dir="ltr" value={vm.preferredToolsText} readOnly={readOnly}
            onChange={(e) => { vm.preferredToolsText = e.target.value; }} />
        </Field>
        <Field id={`${id}-priority`} label={s.skillPriority}>
          <input id={`${id}-priority`} type="number" min={0} max={100} step={1} dir="ltr" value={vm.priority} readOnly={readOnly}
            onChange={(e) => { const n = e.target.valueAsNumber; vm.priority = Number.isFinite(n) ? n : 0; }} />
        </Field>
        <Field id={`${id}-activation`} label={s.skillActivation}>
          <select id={`${id}-activation`} value={vm.activation} disabled={readOnly} onChange={(e) => { vm.activation = e.target.value; }}>
            {vm.activationOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field id={`${id}-license`} label={s.skillLicense}>
          <input id={`${id}-license`} type="text" autoComplete="off" dir="auto" value={vm.license} readOnly={readOnly}
            onChange={(e) => { vm.license = e.target.value; }} />
        </Field>
        <Field id={`${id}-compatibility`} label={s.skillCompatibility}>
          <input id={`${id}-compatibility`} type="text" autoComplete="off" dir="auto" value={vm.compatibility} readOnly={readOnly}
            onChange={(e) => { vm.compatibility = e.target.value; }} />
        </Field>
        {vm.canDropUnknownKeys && (
          <Actions>
            <Button onClick={() => vm.dropUnknownKeys()}>{s.skillDropUnknownKeys}</Button>
          </Actions>
        )}
      </form>

      <h3 dir="auto">{s.skillResources}</h3>
      {!vm.hasResources && <p className="fdn-muted" dir="auto">{s.skillNoResources}</p>}
      {vm.hasResources && (
        <ul className="fdn-skills-files">
          {vm.resources.map((row) => <ResourceRow key={row.path} row={row} s={s} readOnly={readOnly} />)}
        </ul>
      )}
      {vm.canAddResource && (
        <Actions>
          <Button onClick={() => void vm.addResourceFromHost()}>{s.skillAddFile}</Button>
        </Actions>
      )}

      <h3 dir="auto">{s.skillChecksHeading}</h3>
      {!vm.hasIssues && <p className="fdn-skills-ok" dir="auto">{s.skillChecksOk}</p>}
      <Issues items={vm.issues} />

      <Actions>
        {!readOnly && <Button primary submit form={`${id}-form`} disabled={!vm.canSave}>{s.skillSave}</Button>}
        <Button quiet onClick={() => vm.cancel()}>{s.skillCancel}</Button>
      </Actions>

      <TryPanel vm={vm} s={s} id={id} />
    </div>
  );
}

function ResourceRow({ row, s, readOnly }: { row: SkillResourceViewModel; s: UiStrings; readOnly: boolean }): ReactElement {
  const vm = useViewModel(row);
  const id = useId();
  return (
    <li className="fdn-card fdn-skills-row">
      <span className="fdn-skills-name" dir="ltr">{vm.path}</span>
      <span className="fdn-muted">{formatSize(vm.size, s.language)}</span>
      <form className="fdn-wizard-form" noValidate onSubmit={(e) => { e.preventDefault(); vm.rename(); }}>
        <Field id={`${id}-path`} label={`${s.skillRenameFile}: ${vm.path}`}>
          <input id={`${id}-path`} type="text" autoComplete="off" spellCheck={false} dir="ltr" value={vm.newPath} readOnly={readOnly}
            onChange={(e) => { vm.newPath = e.target.value; }} />
        </Field>
        {!readOnly && (
          <Actions>
            <Button submit disabled={!vm.canRename}>{s.skillRenameFile}</Button>
            {vm.canRemove && <Button quiet onClick={() => vm.remove()}>{s.skillRemoveFile}</Button>}
          </Actions>
        )}
      </form>
    </li>
  );
}

function formatSize(bytes: number, language: string): string {
  try {
    return new Intl.NumberFormat(language, { style: "unit", unit: "byte", unitDisplay: "short" }).format(bytes);
  } catch {
    return String(bytes);
  }
}

function TryPanel({ vm, s, id }: { vm: SkillEditorViewModel; s: UiStrings; id: string }): ReactElement {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.runTest();
  };
  return (
    <section className="fdn-card fdn-skills-try" aria-labelledby={`${id}-try`}>
      <h3 id={`${id}-try`} dir="auto">{s.skillTestHeading}</h3>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-prompt`} label={s.skillTestPrompt}>
          <input id={`${id}-prompt`} type="text" autoComplete="off" dir="auto" value={vm.testPrompt} onChange={(e) => { vm.testPrompt = e.target.value; }} />
        </Field>
        <Actions>
          <Button submit>{s.skillTestRun}</Button>
          {vm.canAskModel && <Button disabled={!vm.canAsk} onClick={() => void vm.askModel()}>{s.skillAskModel}</Button>}
        </Actions>
      </form>
      {vm.canAskModel && <p className="fdn-muted" dir="auto">{vm.modelNote}</p>}
      {/* What a test or a question says appears once, when it is answered: a polite status, nothing that ticks. */}
      <div className="fdn-wizard-live" role="status">
        {vm.modelAnswerText && <p dir="auto">{vm.modelAnswerText}</p>}
        {vm.hasTestResult && (
          <>
            {vm.testNote && <p dir="auto">{vm.testNote}</p>}
            {vm.testListed.length > 0 && (
              <>
                <p><strong dir="auto">{s.skillTestListed}</strong></p>
                <ul>{vm.testListed.map((name) => <li key={name} dir="auto">{name}</li>)}</ul>
              </>
            )}
            {vm.testMatches.length > 0 && <ul>{vm.testMatches.map((line) => <li key={line} dir="auto">{line}</li>)}</ul>}
            {vm.testPreloaded.length > 0 && (
              <>
                <p><strong dir="auto">{s.skillTestPreloaded}</strong></p>
                <ul>{vm.testPreloaded.map((name) => <li key={name} dir="auto">{name}</li>)}</ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import { SkillDraftState, type SkillDraftViewModel, type SkillEditorViewModel } from "@fadenstack/ui";

import { Spinner } from "./icons.js";
import { useViewModel } from "./hooks.js";
import { Actions, Alert, Button, Field, Shell, Title, defaultStrings, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface SkillDraftProps extends SkillViewProps {
  /** The draft's view model (`SkillLibraryViewModel.createDraft`, or one the app made). */
  draft: SkillDraftViewModel;
  /** "Edit": the app shows the proposal's editor again. The button shows only when this is given (the library opens it by itself). */
  onOpenProposal?: ((editor: SkillEditorViewModel) => void) | undefined;
}

/**
 * "Draft from this chat" (sdk/51 F04) in the wizard's column: what the skill should be for (optional), the button that asks the
 * model once, the state in words, and the plain statement that **nothing is saved until Save** in the editor the proposal opens in.
 * Enter in the field writes the draft; Escape stops one that is on its way.
 */
export function SkillDraft(props: SkillDraftProps): ReactElement {
  const { strings = defaultStrings, onOpenProposal } = props;
  const vm = useViewModel(props.draft);
  const s = strings();
  const id = useId();
  const column = useRef<HTMLDivElement>(null);
  useFirstFocus(column, [props.draft]);

  const failed = vm.state === SkillDraftState.Failed || vm.state === SkillDraftState.Unreadable;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.draft(); // asks the model once; the proposal opens in the editor, unsaved
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !vm.isWorking) return;
    vm.cancel();
    e.preventDefault();
    e.stopPropagation();
  };

  const proposal = vm.proposal;
  return (
    <Shell s={s} theme={props.theme} className={props.className} busy={vm.isWorking} onKeyDown={onKeyDown} columnRef={column}>
      <Title>{s.skillDraftTitle}</Title>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-guidance`} label={s.skillDraftGuidance}>
          <input id={`${id}-guidance`} type="text" autoComplete="off" dir="auto" value={vm.guidance} readOnly={vm.isWorking}
            data-wizard-focus="" onChange={(e) => { vm.guidance = e.target.value; }} />
        </Field>
        <Actions>
          <Button primary submit disabled={!vm.canDraft}>{s.skillDraftStart}</Button>
        </Actions>
      </form>
      {failed ? <Alert>{vm.statusText}</Alert> : vm.statusText && (
        <p className={vm.isWorking ? "fdn-wizard-busy" : vm.state === SkillDraftState.Ready ? "fdn-skills-message" : "fdn-wizard-note"} role="status" dir="auto">
          {vm.isWorking && <Spinner />}<span>{vm.statusText}</span>
        </p>
      )}
      {proposal && (
        <div className="fdn-card fdn-skills-ask">
          <p dir="auto">{proposal.proposalNote}</p>
          {onOpenProposal && <Actions><Button onClick={() => onOpenProposal(proposal)}>{s.skillEdit}</Button></Actions>}
        </div>
      )}
    </Shell>
  );
}

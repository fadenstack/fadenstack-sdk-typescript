import { useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";

import { SkillDraftState, type SkillDraftViewModel } from "@fadenstack/ui";

import { Spinner } from "./icons.js";
import { useViewModel } from "./hooks.js";
import { Actions, Alert, Button, Field, Shell, Title, useFirstFocus, type SkillViewProps } from "./SkillParts.js";

export interface SkillDraftProps extends SkillViewProps {
  /** The draft's view model (`SkillLibraryViewModel.createDraft`, or one the app made). */
  draft: SkillDraftViewModel;
}

/**
 * "Draft from this chat" (sdk/51 F04) in the wizard's column: what the skill should be for (optional), the button that asks the
 * model once, the state in words, and the plain statement, in every state, that **nothing is saved until Save** in the editor the
 * proposal opens in ("Open the proposal" is the view model's `openProposal()`). The texts are the view model's. Enter in the field
 * writes the draft; Escape stops one that is on its way.
 */
export function SkillDraft(props: SkillDraftProps): ReactElement {
  const vm = useViewModel(props.draft);
  const column = useRef<HTMLDivElement>(null);
  return (
    <Shell s={vm.strings} theme={props.theme} className={props.className} busy={vm.isWorking} onKeyDown={(e) => draftEscape(vm, e)} columnRef={column}>
      <SkillDraftBody draft={props.draft} />
    </Shell>
  );
}

function draftEscape(vm: SkillDraftViewModel, e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || !vm.isWorking) return;
  vm.cancel();
  e.preventDefault();
  e.stopPropagation();
}

/** The draft inside a shell (the library draws it under its buttons when "Draft from this chat" is pressed). */
export function SkillDraftBody({ draft }: { draft: SkillDraftViewModel }): ReactElement {
  const vm = useViewModel(draft);
  const s = vm.strings;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useFirstFocus(root, [draft]);

  const failed = vm.state === SkillDraftState.Failed || vm.state === SkillDraftState.Unreadable;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.draft(); // asks the model once; the proposal opens in the editor, unsaved
  };

  const proposal = vm.proposal;
  return (
    <div className="fdn-skills-draft" ref={root} aria-busy={vm.isWorking} onKeyDown={(e) => draftEscape(vm, e)}>
      <Title>{s.skillDraftTitle}</Title>
      <p className="fdn-wizard-note" dir="auto">{vm.standingNote}</p>
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
          {vm.canOpenProposal && <Actions><Button onClick={() => vm.openProposal()}>{s.skillDraftOpen}</Button></Actions>}
        </div>
      )}
    </div>
  );
}
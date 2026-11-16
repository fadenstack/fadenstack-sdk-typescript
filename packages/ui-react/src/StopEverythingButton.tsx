import type { ReactElement } from "react";

import type { StopEverythingViewModel } from "@fadenstack/ui";

import { useViewModel } from "./hooks.js";
import { Icon } from "./icons.js";
import type { SkillViewProps } from "./SkillParts.js";

export interface StopEverythingButtonProps extends SkillViewProps {
  /** The control's view model (`new StopEverythingViewModel({ agents: () => [...] })`). */
  stop: StopEverythingViewModel;
}

/**
 * "Stop everything", the emergency stop for an app's tray menu or title bar: an icon button named "Stop everything" with a tooltip, and
 * the line that says what it did. No confirmation. The texts and the stop are the view model's. Parity with `@fadenstack/ui-vue`'s
 * `StopEverythingButton`.
 */
export function StopEverythingButton(props: StopEverythingButtonProps): ReactElement {
  const vm = useViewModel(props.stop);
  const s = vm.strings;
  return (
    <div className={`fdn-chat fdn-stop-everything${props.className ? ` ${props.className}` : ""}`} data-theme={props.theme ?? "system"} lang={s.language} dir={s.direction}>
      <button type="button" className="fdn-icon-button fdn-stop-everything-button" aria-label={vm.name} title={vm.toolTip} disabled={!vm.canStop}
        aria-busy={vm.isBusy} onClick={() => { void vm.stop(); }}>
        <Icon name="stop" size={16} />
      </button>
      {vm.hasResult && <span className="fdn-stop-everything-result" role="status" dir="auto">{vm.resultText}</span>}
    </div>
  );
}

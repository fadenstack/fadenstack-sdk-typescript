import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { ConnectionMode, WizardStep, type ConnectionWizardViewModel, type WizardStepHandler } from "@fadenstack/ui";

import { Spinner } from "./icons.js";
import { useViewModel } from "./hooks.js";

export type WizardTheme = "system" | "light" | "dark";

export interface ConnectionWizardProps {
  /** The wizard's view model; the app calls `start()` and listens to `onCompleted`. */
  wizard: ConnectionWizardViewModel;
  /** The app's name, for the titles ("How do you want to use Fadenstack Chrome?"). */
  appName: string;
  /** Draws the app's own step (Chrome's host permission, ...) on a busy step while `wizard.appStep` is set. */
  renderAppStep?: ((step: WizardStepHandler) => ReactNode) | undefined;
  /** "Read the full terms": the app opens its terms page. The button shows only when this is given. */
  onOpenTerms?: (() => void) | undefined;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: WizardTheme;
  className?: string;
}

/**
 * The connection wizard (sdk/51 F15) in one narrow, centred column: one view per `WizardStep`. It only renders: every text
 * is the view model's `strings` (or a computed text), every button is shown by `wizard.can`, and every command is called
 * in the click's own turn (no `await` before it), so the app's step before an endpoint check runs inside the user gesture.
 * A password or a key is read from an uncontrolled input when its button runs, handed to the command, and the input is
 * cleared at once: it is never in state, a prop or the DOM afterwards (ASVS 5.0 V13).
 */
export function ConnectionWizard(props: ConnectionWizardProps): ReactElement | null {
  const { appName, renderAppStep, onOpenTerms, theme = "system" } = props;
  const vm = useViewModel(props.wizard);
  const column = useRef<HTMLDivElement>(null);
  const step = vm.step;

  // A new step takes the focus: its first field, else its title or message, else the column itself.
  useEffect(() => {
    const root = column.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>("[data-wizard-focus]") ?? root.querySelector<HTMLElement>("[data-wizard-title]") ?? root;
    target.focus({ preventScroll: true });
  }, [step]);

  if (step === WizardStep.Finished) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (vm.can.cancel) vm.cancel();
    else if (vm.can.back) vm.back();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className={`fdn-chat fdn-wizard${props.className ? ` ${props.className}` : ""}`} data-theme={theme} lang={vm.strings.language}
      dir={vm.strings.direction} onKeyDown={onKeyDown}>
      <div className="fdn-wizard-column" ref={column} tabIndex={-1} aria-busy={vm.isBusy}>
        <StepView vm={vm} appName={appName} renderAppStep={renderAppStep} onOpenTerms={onOpenTerms} />
      </div>
    </div>
  );
}

interface ViewProps {
  vm: ConnectionWizardViewModel;
}

function StepView({ vm, appName, renderAppStep, onOpenTerms }: ViewProps & Pick<ConnectionWizardProps, "appName" | "renderAppStep" | "onOpenTerms">): ReactElement | null {
  const s = vm.strings;
  switch (vm.step) {
    case WizardStep.BeforeChoice:
    case WizardStep.AppPrecondition:
    case WizardStep.Checking:
    case WizardStep.PairStarting:
    case WizardStep.Approved:
    case WizardStep.Redeeming:
    case WizardStep.ServerAccepted:
    case WizardStep.OwnSearching:
    case WizardStep.BeforeCheck:
    case WizardStep.OwnChecking:
    case WizardStep.OwnDone:
    case WizardStep.AfterConnect:
      return <BusyView vm={vm} line={busyLine(vm)} renderAppStep={renderAppStep} />;
    case WizardStep.Choose:
      return <Choose vm={vm} appName={appName} />;
    case WizardStep.ServerAddress:
      return <ServerAddress vm={vm} />;
    case WizardStep.Unreachable:
      return <Problem vm={vm} text={s.wizardUnreachable} />;
    case WizardStep.CertificateNotTrusted:
      return <Problem vm={vm} text={s.wizardCertificateNotTrusted} />;
    case WizardStep.NotFadenstack:
      return <Problem vm={vm} text={s.wizardNotFadenstack} />;
    case WizardStep.StartFailed:
      return <Problem vm={vm} text={vm.startFailureText ?? s.wizardPairFailed} />;
    case WizardStep.ServerTooOld:
      return <Problem vm={vm} text={s.wizardTooOld} more={vm.can.usePassword ? s.wizardTooOldPassword : undefined} />;
    case WizardStep.Denied:
      return <Problem vm={vm} text={s.wizardDenied} />;
    case WizardStep.Expired:
      return <Problem vm={vm} text={s.wizardExpired} />;
    case WizardStep.PairFailed:
      return <Problem vm={vm} text={s.wizardPairFailed} />;
    case WizardStep.NoAccess:
      return <Problem vm={vm} text={s.wizardNoAccess} />;
    case WizardStep.PasswordError:
      return <Problem vm={vm} text={vm.passwordFailureText ?? s.wizardPasswordFailure.other} />;
    case WizardStep.OwnFailed:
      return <Problem vm={vm} text={vm.problemText ?? s.wizardProblem.Failed} />;
    case WizardStep.PairCode:
      return <PairCode vm={vm} appName={appName} renderAppStep={renderAppStep} />;
    case WizardStep.Password:
      return vm.isBusy ? <BusyView vm={vm} line={s.wizardRedeeming} renderAppStep={renderAppStep} /> : <Password vm={vm} appName={appName} />;
    case WizardStep.SignedIn:
      return (
        <Frame vm={vm}>
          <Live><p dir="auto">{vm.signedInText}</p></Live>
        </Frame>
      );
    case WizardStep.OwnAccept:
      return <OwnAccept vm={vm} onOpenTerms={onOpenTerms} />;
    case WizardStep.OwnPick:
      return <OwnPick vm={vm} />;
    case WizardStep.OwnPlainHttp:
      return (
        <Frame vm={vm} title={s.wizardPlainHttpTitle}>
          <p dir="auto">{s.wizardPlainHttpWarning}</p>
          <Actions>
            {vm.can.confirmPlainHttp && <Button primary onClick={() => void vm.confirmPlainHttp()}>{s.wizardPlainHttpConfirm}</Button>}
            {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
          </Actions>
        </Frame>
      );
    case WizardStep.OwnKey:
      return <OwnKey vm={vm} />;
    case WizardStep.OwnHelp:
      return (
        <Frame vm={vm} title={s.wizardOwnHelpTitle}>
          <p dir="auto">{s.wizardOwnHelp}</p>
          <Actions>
            {vm.can.retry && <Button primary onClick={() => void vm.retry()}>{s.wizardTryAgain}</Button>}
            {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
          </Actions>
        </Frame>
      );
    case WizardStep.OwnResult:
      return (
        <Frame vm={vm} title={s.wizardOwnTitle}>
          <ul className="fdn-wizard-list">
            {vm.resultLines.map((line, i) => <li key={i} dir="auto">{line}</li>)}
          </ul>
          <Actions>
            {vm.can.continue && <Button primary onClick={() => void vm.continue()}>{s.wizardContinue}</Button>}
            {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
          </Actions>
        </Frame>
      );
    case WizardStep.OwnModel:
      return <OwnModel vm={vm} />;
    case WizardStep.Settings:
      return <Settings vm={vm} />;
    case WizardStep.SignOut:
      return <SignOut vm={vm} />;
    default:
      return null;
  }
}

/** The line of a busy step; the app's own steps (before the choice, after connecting) have none: the app's view says it. */
function busyLine(vm: ConnectionWizardViewModel): string | undefined {
  const s = vm.strings;
  switch (vm.step) {
    case WizardStep.AppPrecondition:
    case WizardStep.Checking:
      return s.wizardChecking;
    case WizardStep.PairStarting:
    case WizardStep.ServerAccepted:
      return s.wizardStarting;
    case WizardStep.Approved:
    case WizardStep.Redeeming:
      return s.wizardRedeeming;
    case WizardStep.OwnSearching:
      return s.wizardOwnSearching;
    case WizardStep.BeforeCheck:
    case WizardStep.OwnChecking:
      return s.wizardOwnChecking;
    case WizardStep.OwnDone:
      return s.wizardOwnDone;
    default:
      return undefined;
  }
}

// ---- Building blocks ----

/** A polite live region: what changes in it is read out. */
function Live({ children }: { children?: ReactNode }): ReactElement {
  return <div className="fdn-wizard-live" aria-live="polite">{children}</div>;
}

function Alert({ children, focus }: { children: ReactNode; focus?: boolean }): ReactElement {
  return (
    <p className="fdn-wizard-error" role="alert" dir="auto" tabIndex={focus ? -1 : undefined} data-wizard-focus={focus ? "" : undefined}>
      {children}
    </p>
  );
}

/** What went wrong with the app's own parts, on any step that shows them. */
function Notes({ vm }: ViewProps): ReactElement | null {
  if (!vm.storeFailed && !vm.appStepRefused) return null;
  return (
    <>
      {vm.storeFailed && <Alert>{vm.strings.wizardStoreFailed}</Alert>}
      {vm.appStepRefused && <Alert>{vm.strings.wizardAppStepRefused}</Alert>}
    </>
  );
}

function Frame({ vm, title, children }: ViewProps & { title?: string | undefined; children: ReactNode }): ReactElement {
  return (
    <>
      {title !== undefined && <h2 className="fdn-wizard-title" tabIndex={-1} data-wizard-title="" dir="auto">{title}</h2>}
      <Notes vm={vm} />
      {children}
    </>
  );
}

function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="fdn-wizard-actions">{children}</div>;
}

function Button({ onClick, children, primary, quiet, disabled, submit, pressed, describedBy }: {
  onClick?: () => void; children: ReactNode; primary?: boolean; quiet?: boolean; disabled?: boolean; submit?: boolean; pressed?: boolean;
  describedBy?: string;
}): ReactElement {
  const cls = `fdn-button${primary ? " fdn-primary" : ""}${quiet ? " fdn-quiet" : ""}${pressed ? " fdn-selected" : ""}`;
  return (
    <button type={submit ? "submit" : "button"} className={cls} disabled={disabled} onClick={onClick} aria-pressed={pressed}
      aria-describedby={describedBy} dir="auto">
      {children}
    </button>
  );
}

function Field({ label, children, id }: { label: string; children: ReactElement; id: string }): ReactElement {
  return (
    <div className="fdn-wizard-field">
      <label htmlFor={id} dir="auto">{label}</label>
      {children}
    </div>
  );
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }): ReactElement {
  return (
    <div className="fdn-wizard-check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} dir="auto">{label}</label>
    </div>
  );
}

// ---- Busy steps ----

function BusyView({ vm, line, renderAppStep }: ViewProps & { line: string | undefined; renderAppStep: ConnectionWizardProps["renderAppStep"] }): ReactElement {
  const appStep = vm.appStep;
  return (
    <>
      <Live>
        <p className="fdn-wizard-busy" dir="auto">
          <Spinner />
          {line !== undefined && <span>{line}</span>}
        </p>
      </Live>
      {appStep && renderAppStep?.(appStep)}
      {vm.can.cancel && (
        <Actions>
          <Button onClick={() => vm.cancel()}>{vm.strings.wizardCancel}</Button>
        </Actions>
      )}
    </>
  );
}

// ---- The choice and Path A ----

function Choose({ vm, appName }: ViewProps & { appName: string }): ReactElement {
  const s = vm.strings;
  const id = useId();
  const none = !vm.can.chooseServer && !vm.can.chooseOwnAi && !vm.can.chooseDemo;
  return (
    <Frame vm={vm} title={s.wizardChooseTitle(appName)}>
      {vm.can.chooseServer && (
        <button type="button" className="fdn-suggestion fdn-wizard-choice" aria-labelledby={`${id}-server-name`} aria-describedby={`${id}-server`} onClick={() => vm.chooseServer()}>
          <span id={`${id}-server-name`} className="fdn-wizard-choice-name" dir="auto">{s.wizardChooseServer}</span>
          <span id={`${id}-server`} className="fdn-muted" dir="auto">{s.wizardChooseServerHelp}</span>
        </button>
      )}
      {vm.can.chooseOwnAi && (
        <button type="button" className="fdn-suggestion fdn-wizard-choice" aria-labelledby={`${id}-own-name`} aria-describedby={`${id}-own`} onClick={() => vm.chooseOwnAi()}>
          <span id={`${id}-own-name`} className="fdn-wizard-choice-name" dir="auto">{s.wizardChooseOwnAi}</span>
          <span id={`${id}-own`} className="fdn-muted" dir="auto">{s.wizardChooseOwnAiHelp}</span>
        </button>
      )}
      {vm.can.chooseDemo && (
        <button type="button" className="fdn-suggestion fdn-wizard-choice" onClick={() => vm.chooseDemo()}>
          <span className="fdn-wizard-choice-name" dir="auto">{s.wizardChooseDemo}</span>
        </button>
      )}
      {none && (
        <>
          <Alert>{s.wizardNothingAllowed}</Alert>
          <Actions>{vm.can.close && <Button onClick={() => vm.close()}>{s.wizardClose}</Button>}</Actions>
        </>
      )}
    </Frame>
  );
}

function ServerAddress({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const id = useId();
  const locked = vm.serverLocked;
  const error = vm.addressErrorText;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.submitServer(); // called in this event, before any await: the app's step runs inside the gesture
  };
  return (
    <Frame vm={vm} title={s.wizardServerTitle}>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-address`} label={s.wizardServerLabel}>
          <input id={`${id}-address`} type="text" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr"
            value={vm.serverAddressText} readOnly={locked} placeholder={s.wizardServerPlaceholder}
            aria-invalid={error ? true : undefined} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            data-wizard-focus={locked ? undefined : ""} onChange={(e) => { vm.serverAddressText = e.target.value; }} />
        </Field>
        <p id={`${id}-help`} className="fdn-muted" dir="auto">{locked ? s.wizardServerLocked : s.wizardServerHelp}</p>
        {error && <p id={`${id}-error`} className="fdn-wizard-error" role="alert" dir="auto">{error}</p>}
        <Actions>
          {vm.can.submitServer && <Button primary submit>{s.wizardContinue}</Button>}
          {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
        </Actions>
      </form>
    </Frame>
  );
}

/** An error step: the message, then the buttons its commands allow. */
function Problem({ vm, text, more }: ViewProps & { text: string; more?: string | undefined }): ReactElement {
  const s = vm.strings;
  const can = vm.can;
  return (
    <Frame vm={vm}>
      <Alert focus>{text}</Alert>
      {more && <p dir="auto">{more}</p>}
      <Actions>
        {can.retry && <Button primary onClick={() => void vm.retry()}>{s.wizardTryAgain}</Button>}
        {can.newCode && <Button primary onClick={() => void vm.newCode()}>{s.wizardNewCode}</Button>}
        {can.enterKey && <Button primary onClick={() => vm.enterKey()}>{s.wizardEnterKey}</Button>}
        {can.showHelp && <Button onClick={() => vm.showHelp()}>{s.wizardShowHelp}</Button>}
        {can.usePassword && <Button onClick={() => vm.usePassword()}>{s.wizardUsePassword}</Button>}
        {can.backToCode && <Button onClick={() => void vm.backToCode()}>{s.wizardBackToCode}</Button>}
        {can.changeServer && <Button onClick={() => vm.changeServer()}>{s.wizardChangeServer}</Button>}
        {can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
        {can.close && <Button quiet onClick={() => vm.close()}>{s.wizardClose}</Button>}
      </Actions>
    </Frame>
  );
}

function PairCode({ vm, appName, renderAppStep }: ViewProps & { appName: string; renderAppStep: ConnectionWizardProps["renderAppStep"] }): ReactElement {
  const s = vm.strings;
  const id = useId();
  const server = vm.serverUrl?.href;
  return (
    <Frame vm={vm} title={s.wizardCodeTitle(appName)}>
      {vm.signInEnded && <p className="fdn-wizard-note" dir="auto">{s.wizardSignInEnded}</p>}
      <p dir="auto">{s.wizardCodeIntro}</p>
      <div className="fdn-wizard-code">
        <span id={`${id}-name`} className="fdn-label" dir="auto">{s.wizardCodeName}</span>
        <code aria-labelledby={`${id}-name`} dir="ltr">{vm.userCode}</code>
      </div>
      <Actions>
        {vm.can.openPairingPage && <Button primary onClick={() => vm.openPairingPage()}>{s.wizardOpenPage}</Button>}
        {vm.can.copyCode && <Button onClick={() => vm.copyCode()}>{s.wizardCopyCode}</Button>}
      </Actions>
      {/* A countdown is a timer, not a live region: a screen reader reads it when asked, not every second. */}
      <div className="fdn-wizard-live" role="timer" aria-live="off">
        {vm.waitingText !== undefined && <p className="fdn-wizard-busy" dir="auto"><Spinner /><span>{vm.waitingText}</span></p>}
      </div>
      {vm.appStep && renderAppStep?.(vm.appStep)}
      {server && (
        <p className="fdn-muted" dir="auto">
          {s.wizardServerAt(server)}
        </p>
      )}
      <Actions>
        {vm.can.changeServer && <Button onClick={() => vm.changeServer()}>{s.wizardChangeServer}</Button>}
        {vm.can.usePassword && <Button onClick={() => vm.usePassword()}>{s.wizardUsePassword}</Button>}
        {vm.can.cancel && <Button quiet onClick={() => vm.cancel()}>{s.wizardCancel}</Button>}
      </Actions>
    </Frame>
  );
}

function Password({ vm, appName }: ViewProps & { appName: string }): ReactElement {
  const s = vm.strings;
  const id = useId();
  const password = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = password.current;
    if (!input) return;
    const run = vm.signInWithPassword(input.value); // read now, handed on, and gone from the input
    input.value = "";
    void run;
  };
  return (
    <Frame vm={vm} title={s.wizardCodeTitle(appName)}>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-email`} label={s.wizardEmail}>
          <input id={`${id}-email`} type="email" autoComplete="username" spellCheck={false} dir="ltr" value={vm.email}
            data-wizard-focus="" onChange={(e) => { vm.email = e.target.value; }} />
        </Field>
        <Field id={`${id}-password`} label={s.wizardPassword}>
          <input id={`${id}-password`} ref={password} type="password" autoComplete="current-password" dir="ltr" />
        </Field>
        <Actions>
          {vm.can.signInWithPassword && <Button primary submit>{s.wizardSignIn}</Button>}
          {vm.can.backToCode && <Button onClick={() => void vm.backToCode()}>{s.wizardBackToCode}</Button>}
        </Actions>
      </form>
    </Frame>
  );
}

// ---- Path B ----

function OwnAccept({ vm, onOpenTerms }: ViewProps & Pick<ConnectionWizardProps, "onOpenTerms">): ReactElement {
  const s = vm.strings;
  const id = useId();
  const german = /^de(?:-|_|$)/i.test(s.language);
  return (
    <Frame vm={vm} title={s.wizardOwnTitle}>
      <p dir="auto">{s.wizardOwnDataFlow}</p>
      <p dir="auto">{s.wizardOwnProviderTerms}</p>
      <div className="fdn-wizard-terms" role="region" tabIndex={0} aria-label={s.wizardOwnTitle}>
        <p dir="auto">{s.wizardOwnNotice}</p>
        <p dir="auto">{s.wizardOwnLiability}</p>
        {!german && <p dir="auto">{s.wizardOwnBindingVersion}</p>}
      </div>
      {onOpenTerms && <Button quiet onClick={onOpenTerms}>{s.wizardOwnFullTerms}</Button>}
      <Check id={`${id}-consent`} label={s.wizardOwnConsent} checked={vm.accepted} onChange={(on) => { vm.accepted = on; }} />
      {vm.canSearchThisComputer && (
        <Check id={`${id}-search`} label={s.wizardOwnSearchConsent} checked={vm.searchConsent} onChange={(on) => { vm.searchConsent = on; }} />
      )}
      <Actions>
        <Button primary disabled={!vm.can.accept} onClick={() => void vm.accept()}>{s.wizardOwnAccept}</Button>
        {vm.can.serverModeInstead && <Button onClick={() => vm.serverModeInstead()}>{s.wizardOwnServerInstead}</Button>}
        {vm.can.back && <Button quiet onClick={() => vm.back()}>{s.wizardBack}</Button>}
      </Actions>
    </Frame>
  );
}

function OwnPick({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const id = useId();
  const error = vm.addressErrorText;
  const searched = vm.searchConsent && vm.canSearchThisComputer;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void vm.useEndpoint(); // called in this event, before any await: the app's step runs inside the gesture
  };
  return (
    <Frame vm={vm} title={s.wizardOwnPickTitle}>
      {(vm.found.length > 0 || searched) && (
        <section aria-labelledby={`${id}-found`} className="fdn-wizard-form">
          <h3 id={`${id}-found`} className="fdn-label">{s.wizardOwnFound}</h3>
          {vm.found.length === 0 ? (
            <p className="fdn-muted" dir="auto">{s.wizardOwnNothingFound}</p>
          ) : (
            <div className="fdn-wizard-presets">
              {vm.found.map((f) => (
                <Button key={f.baseUrl.href} pressed={vm.endpointAddressText === f.baseUrl.href} onClick={() => vm.selectFound(f)}>
                  {`${f.preset?.name ?? f.baseUrl.host} (${f.baseUrl.host})`}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}
      <section aria-labelledby={`${id}-presets`} className="fdn-wizard-form">
        <h3 id={`${id}-presets`} className="fdn-label">{s.wizardOwnPresets}</h3>
        <div className="fdn-wizard-presets">
          {vm.presets.map((p) => (
            <Button key={p.id} pressed={vm.selectedPreset?.id === p.id} onClick={() => vm.selectPreset(p)}>{p.name}</Button>
          ))}
        </div>
      </section>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-address`} label={s.wizardOwnAddress}>
          <input id={`${id}-address`} type="text" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr"
            value={vm.endpointAddressText} placeholder={s.wizardOwnAddressPlaceholder} data-wizard-focus=""
            aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => { vm.endpointAddressText = e.target.value; }} />
        </Field>
        <Check id={`${id}-needs-key`} label={s.wizardOwnNeedsKey} checked={vm.needsKey} onChange={(on) => { vm.needsKey = on; }} />
        {error && <p id={`${id}-error`} className="fdn-wizard-error" role="alert" dir="auto">{error}</p>}
        <Actions>
          {vm.can.useEndpoint && <Button primary submit>{s.wizardOwnUse}</Button>}
          {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
        </Actions>
      </form>
    </Frame>
  );
}

function OwnKey({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const id = useId();
  const key = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = key.current;
    if (!input) return;
    const run = vm.submitKey(input.value); // read now, handed to the key store, and gone from the input
    input.value = "";
    void run;
  };
  return (
    <Frame vm={vm} title={s.wizardKeyTitle}>
      <form className="fdn-wizard-form" onSubmit={submit} noValidate>
        <Field id={`${id}-key`} label={s.wizardKeyLabel}>
          <input id={`${id}-key`} ref={key} type="password" autoComplete="off" spellCheck={false} dir="ltr" data-wizard-focus=""
            aria-describedby={`${id}-help`} />
        </Field>
        <p id={`${id}-help`} className="fdn-muted" dir="auto">{s.wizardKeyHelp}</p>
        <Actions>
          {vm.can.submitKey && <Button primary submit>{s.wizardCheck}</Button>}
          {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
        </Actions>
      </form>
    </Frame>
  );
}

function OwnModel({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const id = useId();
  return (
    <Frame vm={vm} title={s.wizardModelTitle}>
      <Field id={`${id}-model`} label={s.wizardModelLabel}>
        <select id={`${id}-model`} value={vm.selectedModel ?? ""} data-wizard-focus="" dir="ltr"
          onChange={(e) => { vm.selectedModel = e.target.value; }}>
          {vm.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Actions>
        {vm.can.continue && <Button primary onClick={() => void vm.continue()}>{s.wizardContinue}</Button>}
        {vm.can.back && <Button onClick={() => vm.back()}>{s.wizardBack}</Button>}
      </Actions>
    </Frame>
  );
}

// ---- Settings ----

function Settings({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const own = vm.current?.mode === ConnectionMode.Endpoint;
  const connected = vm.connectedText;
  return (
    <Frame vm={vm} title={s.wizardSettingsTitle}>
      {connected && <p dir="auto">{connected}</p>}
      <Actions>
        {vm.can.connectOrganisation && <Button onClick={() => vm.connectOrganisation()}>{s.wizardConnectOrganisation}</Button>}
        {vm.can.changeEndpoint && <Button onClick={() => vm.changeEndpoint()}>{s.wizardChangeEndpoint}</Button>}
        {vm.can.signOut && <Button onClick={() => vm.signOut()}>{own ? s.wizardRemoveEndpoint : s.wizardSignOut}</Button>}
        {vm.can.close && <Button quiet onClick={() => vm.close()}>{s.wizardClose}</Button>}
      </Actions>
    </Frame>
  );
}

function SignOut({ vm }: ViewProps): ReactElement {
  const s = vm.strings;
  const id = useId();
  const own = vm.current?.mode === ConnectionMode.Endpoint;
  return (
    <Frame vm={vm} title={own ? s.wizardRemoveTitle : s.wizardSignOutTitle}>
      <p dir="auto">{own ? s.wizardRemoveBody : s.wizardSignOutBody}</p>
      <Check id={`${id}-chats`} label={s.wizardDeleteChats} checked={vm.deleteLocalChats} onChange={(on) => { vm.deleteLocalChats = on; }} />
      <Actions>
        {vm.can.confirmSignOut && <Button primary onClick={() => void vm.confirmSignOut()}>{own ? s.wizardRemoveEndpoint : s.wizardSignOut}</Button>}
        {vm.can.cancel && <Button onClick={() => vm.cancel()}>{s.wizardCancel}</Button>}
      </Actions>
    </Frame>
  );
}

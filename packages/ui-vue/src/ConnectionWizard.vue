<script setup lang="ts">
/**
 * The connection wizard (sdk/51 F15) in one narrow, centred column: one view per `WizardStep`. It only renders: every text
 * is the view model's `strings` (or a computed text), every button is shown by `wizard.can`, and every command is called in
 * the event's own turn (no `await` before it), so the app's step before an endpoint check runs inside the user gesture. A
 * password or a key is read from an uncontrolled input when its button runs, handed to the command, and the input is
 * cleared at once: it is never in a ref, a `v-model` or a prop afterwards (ASVS 5.0 V13). Parity with
 * `@fadenstack/ui-react`'s `ConnectionWizard`.
 */
import { computed, getCurrentInstance, nextTick, onMounted, ref, useId, watch } from "vue";

import { ConnectionMode, WizardStep, type ConnectionWizardViewModel, type WizardStepHandler } from "@fadenstack/ui";

import { useViewModel } from "./composables.js";
import Spinner from "./Spinner.vue";
import type { ChatTheme } from "./types.js";

const props = withDefaults(defineProps<{
  /** The wizard's view model; the app calls `start()` and listens to `onCompleted`. */
  wizard: ConnectionWizardViewModel;
  /** The app's name, for the titles ("How do you want to use Fadenstack Chrome?"). */
  appName: string;
  /** `system` (default) follows the browser's light or dark setting. */
  theme?: ChatTheme;
}>(), { theme: "system" });

const emit = defineEmits<{
  /** "Read the full terms": the app opens its terms page. The button shows only when something listens. */
  "open-terms": [];
}>();

defineSlots<{
  /** Draws the app's own step (Chrome's host permission, ...) on a busy step while `wizard.appStep` is set. */
  "app-step"?(props: { step: WizardStepHandler }): unknown;
}>();

const S = WizardStep;
const self = getCurrentInstance();
/** "Read the full terms" shows only when the app listens for it (as the React skin's `onOpenTerms`). */
const hasTermsListener = (): boolean => self?.vnode.props?.["onOpenTerms"] !== undefined;
const vm = useViewModel(() => props.wizard);
const s = computed(() => vm.value.strings);
const id = useId();
const column = ref<HTMLElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const keyInput = ref<HTMLInputElement | null>(null);

// A new step takes the focus: its first field, else its title or message, else the column itself.
function focusStep(): void {
  const root = column.value;
  if (!root) return;
  const target = root.querySelector<HTMLElement>("[data-wizard-focus]") ?? root.querySelector<HTMLElement>("[data-wizard-title]") ?? root;
  target.focus({ preventScroll: true });
}
onMounted(focusStep);
watch(() => vm.value.step, () => nextTick(focusStep), { flush: "post" });

const BUSY_STEPS: ReadonlySet<WizardStep> = new Set([
  S.BeforeChoice, S.AppPrecondition, S.Checking, S.PairStarting, S.Approved, S.Redeeming, S.ServerAccepted, S.OwnSearching,
  S.BeforeCheck, S.OwnChecking, S.OwnDone, S.AfterConnect,
]);

/** A busy view: a step that runs, or the password sign-in while it waits for the server. */
const busyView = computed(() => BUSY_STEPS.has(vm.value.step) || (vm.value.step === S.Password && vm.value.isBusy));

/** The line of a busy step; the app's own steps (before the choice, after connecting) have none: the app's view says it. */
function busyLine(): string | undefined {
  const t = s.value;
  switch (vm.value.step) {
    case S.AppPrecondition:
    case S.Checking:
      return t.wizardChecking;
    case S.PairStarting:
    case S.ServerAccepted:
      return t.wizardStarting;
    case S.Approved:
    case S.Redeeming:
    case S.Password:
      return t.wizardRedeeming;
    case S.OwnSearching:
      return t.wizardOwnSearching;
    case S.BeforeCheck:
    case S.OwnChecking:
      return t.wizardOwnChecking;
    case S.OwnDone:
      return t.wizardOwnDone;
    default:
      return undefined;
  }
}

/** The message of an error step, and an extra line under it; undefined for any other step. */
function problem(): { text: string; more?: string } | undefined {
  const t = s.value;
  const v = vm.value;
  switch (v.step) {
    case S.Unreachable:
      return { text: t.wizardUnreachable };
    case S.CertificateNotTrusted:
      return { text: t.wizardCertificateNotTrusted };
    case S.NotFadenstack:
      return { text: t.wizardNotFadenstack };
    case S.StartFailed:
      return { text: v.startFailureText ?? t.wizardPairFailed };
    case S.ServerTooOld:
      return v.can.usePassword ? { text: t.wizardTooOld, more: t.wizardTooOldPassword } : { text: t.wizardTooOld };
    case S.Denied:
      return { text: t.wizardDenied };
    case S.Expired:
      return { text: t.wizardExpired };
    case S.PairFailed:
      return { text: t.wizardPairFailed };
    case S.NoAccess:
      return { text: t.wizardNoAccess };
    case S.PasswordError:
      return { text: v.passwordFailureText ?? t.wizardPasswordFailure.other };
    case S.OwnFailed:
      return { text: v.problemText ?? t.wizardProblem.Failed };
    default:
      return undefined;
  }
}

const ownsEndpoint = computed(() => vm.value.current?.mode === ConnectionMode.Endpoint);

function title(): string | undefined {
  const t = s.value;
  const v = vm.value;
  switch (v.step) {
    case S.Choose:
      return t.wizardChooseTitle(props.appName);
    case S.ServerAddress:
      return t.wizardServerTitle;
    case S.PairCode:
    case S.Password:
      return busyView.value ? undefined : t.wizardCodeTitle(props.appName);
    case S.OwnAccept:
    case S.OwnResult:
      return t.wizardOwnTitle;
    case S.OwnPick:
      return t.wizardOwnPickTitle;
    case S.OwnPlainHttp:
      return t.wizardPlainHttpTitle;
    case S.OwnKey:
      return t.wizardKeyTitle;
    case S.OwnHelp:
      return t.wizardOwnHelpTitle;
    case S.OwnModel:
      return t.wizardModelTitle;
    case S.Settings:
      return t.wizardSettingsTitle;
    case S.SignOut:
      return ownsEndpoint.value ? t.wizardRemoveTitle : t.wizardSignOutTitle;
    default:
      return undefined;
  }
}

const isGerman = computed(() => /^de(?:-|_|$)/i.test(s.value.language));
const nothingAllowed = computed(() => !vm.value.can.chooseServer && !vm.value.can.chooseOwnAi && !vm.value.can.chooseDemo);

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const v = vm.value;
  if (v.can.cancel) v.cancel();
  else if (v.can.back) v.back();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

const valueOf = (e: Event): string => (e.target as HTMLInputElement | HTMLSelectElement).value;
const checkedOf = (e: Event): boolean => (e.target as HTMLInputElement).checked;

function submitServer(): void {
  void vm.value.submitServer(); // called in this event, before any await: the app's step runs inside the gesture
}

function submitEndpoint(): void {
  void vm.value.useEndpoint(); // the same: Chrome's permission request needs the gesture
}

function submitPassword(): void {
  const input = passwordInput.value;
  if (!input) return;
  const run = vm.value.signInWithPassword(input.value); // read now, handed on, and gone from the input
  input.value = "";
  void run;
}

function submitKey(): void {
  const input = keyInput.value;
  if (!input) return;
  const run = vm.value.submitKey(input.value); // read now, handed to the key store, and gone from the input
  input.value = "";
  void run;
}
</script>

<template>
  <div v-if="vm.step !== S.Finished" class="fdn-chat fdn-wizard" :data-theme="theme" :lang="s.language" :dir="s.direction" @keydown="onKeyDown">
    <div ref="column" class="fdn-wizard-column" tabindex="-1" :aria-busy="vm.isBusy">
      <h2 v-if="title() !== undefined" class="fdn-wizard-title" tabindex="-1" data-wizard-title dir="auto">{{ title() }}</h2>
      <template v-if="!busyView">
        <p v-if="vm.storeFailed" class="fdn-wizard-error" role="alert" dir="auto">{{ s.wizardStoreFailed }}</p>
        <p v-if="vm.appStepRefused" class="fdn-wizard-error" role="alert" dir="auto">{{ s.wizardAppStepRefused }}</p>
      </template>

      <!-- a busy step: the spinner, its line, the app's own step, Cancel -->
      <template v-if="busyView">
        <div class="fdn-wizard-live" aria-live="polite">
          <p class="fdn-wizard-busy" dir="auto">
            <Spinner />
            <span v-if="busyLine() !== undefined">{{ busyLine() }}</span>
          </p>
        </div>
        <slot v-if="vm.appStep" name="app-step" :step="vm.appStep" />
        <div v-if="vm.can.cancel" class="fdn-wizard-actions">
          <button type="button" class="fdn-button" @click="vm.cancel()">{{ s.wizardCancel }}</button>
        </div>
      </template>

      <!-- an error step: the message, then the buttons its commands allow -->
      <template v-else-if="problem() !== undefined">
        <p class="fdn-wizard-error" role="alert" dir="auto" tabindex="-1" data-wizard-focus>{{ problem()!.text }}</p>
        <p v-if="problem()!.more" dir="auto">{{ problem()!.more }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.retry" type="button" class="fdn-button fdn-primary" @click="vm.retry()">{{ s.wizardTryAgain }}</button>
          <button v-if="vm.can.newCode" type="button" class="fdn-button fdn-primary" @click="vm.newCode()">{{ s.wizardNewCode }}</button>
          <button v-if="vm.can.enterKey" type="button" class="fdn-button fdn-primary" @click="vm.enterKey()">{{ s.wizardEnterKey }}</button>
          <button v-if="vm.can.showHelp" type="button" class="fdn-button" @click="vm.showHelp()">{{ s.wizardShowHelp }}</button>
          <button v-if="vm.can.usePassword" type="button" class="fdn-button" @click="vm.usePassword()">{{ s.wizardUsePassword }}</button>
          <button v-if="vm.can.backToCode" type="button" class="fdn-button" @click="vm.backToCode()">{{ s.wizardBackToCode }}</button>
          <button v-if="vm.can.changeServer" type="button" class="fdn-button" @click="vm.changeServer()">{{ s.wizardChangeServer }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
          <button v-if="vm.can.close" type="button" class="fdn-button fdn-quiet" @click="vm.close()">{{ s.wizardClose }}</button>
        </div>
      </template>

      <!-- the choice -->
      <template v-else-if="vm.step === S.Choose">
        <button v-if="vm.can.chooseServer" type="button" class="fdn-suggestion fdn-wizard-choice" :aria-labelledby="`${id}-server-name`"
          :aria-describedby="`${id}-server`" @click="vm.chooseServer()">
          <span :id="`${id}-server-name`" class="fdn-wizard-choice-name" dir="auto">{{ s.wizardChooseServer }}</span>
          <span :id="`${id}-server`" class="fdn-muted" dir="auto">{{ s.wizardChooseServerHelp }}</span>
        </button>
        <button v-if="vm.can.chooseOwnAi" type="button" class="fdn-suggestion fdn-wizard-choice" :aria-labelledby="`${id}-own-name`"
          :aria-describedby="`${id}-own`" @click="vm.chooseOwnAi()">
          <span :id="`${id}-own-name`" class="fdn-wizard-choice-name" dir="auto">{{ s.wizardChooseOwnAi }}</span>
          <span :id="`${id}-own`" class="fdn-muted" dir="auto">{{ s.wizardChooseOwnAiHelp }}</span>
        </button>
        <button v-if="vm.can.chooseDemo" type="button" class="fdn-suggestion fdn-wizard-choice" @click="vm.chooseDemo()">
          <span class="fdn-wizard-choice-name" dir="auto">{{ s.wizardChooseDemo }}</span>
        </button>
        <template v-if="nothingAllowed">
          <p class="fdn-wizard-error" role="alert" dir="auto">{{ s.wizardNothingAllowed }}</p>
          <div class="fdn-wizard-actions">
            <button v-if="vm.can.close" type="button" class="fdn-button" @click="vm.close()">{{ s.wizardClose }}</button>
          </div>
        </template>
      </template>

      <!-- path A: the server's address -->
      <form v-else-if="vm.step === S.ServerAddress" class="fdn-wizard-form" novalidate @submit.prevent="submitServer">
        <div class="fdn-wizard-field">
          <label :for="`${id}-address`" dir="auto">{{ s.wizardServerLabel }}</label>
          <input :id="`${id}-address`" type="text" inputmode="url" autocomplete="off" :spellcheck="false" dir="ltr"
            :value="vm.serverAddressText" :readonly="vm.serverLocked" :placeholder="s.wizardServerPlaceholder"
            :aria-invalid="vm.addressErrorText ? 'true' : undefined"
            :aria-describedby="`${id}-help${vm.addressErrorText ? ` ${id}-error` : ''}`"
            :data-wizard-focus="vm.serverLocked ? undefined : ''" @input="vm.serverAddressText = valueOf($event)">
        </div>
        <p :id="`${id}-help`" class="fdn-muted" dir="auto">{{ vm.serverLocked ? s.wizardServerLocked : s.wizardServerHelp }}</p>
        <p v-if="vm.addressErrorText" :id="`${id}-error`" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.addressErrorText }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.submitServer" type="submit" class="fdn-button fdn-primary">{{ s.wizardContinue }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </form>

      <!-- path A: the code -->
      <template v-else-if="vm.step === S.PairCode">
        <p v-if="vm.signInEnded" class="fdn-wizard-note" dir="auto">{{ s.wizardSignInEnded }}</p>
        <p dir="auto">{{ s.wizardCodeIntro }}</p>
        <div class="fdn-wizard-code">
          <span :id="`${id}-code-name`" class="fdn-label" dir="auto">{{ s.wizardCodeName }}</span>
          <code :aria-labelledby="`${id}-code-name`" dir="ltr">{{ vm.userCode }}</code>
        </div>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.openPairingPage" type="button" class="fdn-button fdn-primary" @click="vm.openPairingPage()">{{ s.wizardOpenPage }}</button>
          <button v-if="vm.can.copyCode" type="button" class="fdn-button" @click="vm.copyCode()">{{ s.wizardCopyCode }}</button>
        </div>
        <!-- A countdown is a timer, not a live region: a screen reader reads it when asked, not every second. -->
        <div class="fdn-wizard-live" role="timer" aria-live="off">
          <p v-if="vm.waitingText !== undefined" class="fdn-wizard-busy" dir="auto"><Spinner /><span>{{ vm.waitingText }}</span></p>
        </div>
        <slot v-if="vm.appStep" name="app-step" :step="vm.appStep" />
        <p v-if="vm.serverUrl" class="fdn-muted" dir="auto">{{ s.wizardServerAt(vm.serverUrl.href) }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.changeServer" type="button" class="fdn-button" @click="vm.changeServer()">{{ s.wizardChangeServer }}</button>
          <button v-if="vm.can.usePassword" type="button" class="fdn-button" @click="vm.usePassword()">{{ s.wizardUsePassword }}</button>
          <button v-if="vm.can.cancel" type="button" class="fdn-button fdn-quiet" @click="vm.cancel()">{{ s.wizardCancel }}</button>
        </div>
      </template>

      <!-- path A: the password -->
      <form v-else-if="vm.step === S.Password" class="fdn-wizard-form" novalidate @submit.prevent="submitPassword">
        <div class="fdn-wizard-field">
          <label :for="`${id}-email`" dir="auto">{{ s.wizardEmail }}</label>
          <input :id="`${id}-email`" type="email" autocomplete="username" :spellcheck="false" dir="ltr" :value="vm.email" data-wizard-focus
            @input="vm.email = valueOf($event)">
        </div>
        <div class="fdn-wizard-field">
          <label :for="`${id}-password`" dir="auto">{{ s.wizardPassword }}</label>
          <input :id="`${id}-password`" ref="passwordInput" type="password" autocomplete="current-password" dir="ltr">
        </div>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.signInWithPassword" type="submit" class="fdn-button fdn-primary">{{ s.wizardSignIn }}</button>
          <button v-if="vm.can.backToCode" type="button" class="fdn-button" @click="vm.backToCode()">{{ s.wizardBackToCode }}</button>
        </div>
      </form>

      <div v-else-if="vm.step === S.SignedIn" class="fdn-wizard-live" aria-live="polite">
        <p dir="auto">{{ vm.signedInText }}</p>
      </div>

      <!-- path B: the terms -->
      <template v-else-if="vm.step === S.OwnAccept">
        <p dir="auto">{{ s.wizardOwnDataFlow }}</p>
        <p dir="auto">{{ s.wizardOwnProviderTerms }}</p>
        <div class="fdn-wizard-terms" role="region" tabindex="0" :aria-label="s.wizardOwnTitle">
          <p dir="auto">{{ s.wizardOwnNotice }}</p>
          <p dir="auto">{{ s.wizardOwnLiability }}</p>
          <p v-if="!isGerman" dir="auto">{{ s.wizardOwnBindingVersion }}</p>
        </div>
        <button v-if="hasTermsListener()" type="button" class="fdn-button fdn-quiet" @click="emit('open-terms')">{{ s.wizardOwnFullTerms }}</button>
        <div class="fdn-wizard-check">
          <input :id="`${id}-consent`" type="checkbox" :checked="vm.accepted" @change="vm.accepted = checkedOf($event)">
          <label :for="`${id}-consent`" dir="auto">{{ s.wizardOwnConsent }}</label>
        </div>
        <div v-if="vm.canSearchThisComputer" class="fdn-wizard-check">
          <input :id="`${id}-search`" type="checkbox" :checked="vm.searchConsent" @change="vm.searchConsent = checkedOf($event)">
          <label :for="`${id}-search`" dir="auto">{{ s.wizardOwnSearchConsent }}</label>
        </div>
        <div class="fdn-wizard-actions">
          <button type="button" class="fdn-button fdn-primary" :disabled="!vm.can.accept" @click="vm.accept()">{{ s.wizardOwnAccept }}</button>
          <button v-if="vm.can.serverModeInstead" type="button" class="fdn-button" @click="vm.serverModeInstead()">{{ s.wizardOwnServerInstead }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button fdn-quiet" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </template>

      <!-- path B: the pick -->
      <template v-else-if="vm.step === S.OwnPick">
        <section v-if="vm.found.length > 0 || (vm.searchConsent && vm.canSearchThisComputer)" :aria-labelledby="`${id}-found`" class="fdn-wizard-form">
          <h3 :id="`${id}-found`" class="fdn-label">{{ s.wizardOwnFound }}</h3>
          <p v-if="vm.found.length === 0" class="fdn-muted" dir="auto">{{ s.wizardOwnNothingFound }}</p>
          <div v-else class="fdn-wizard-presets">
            <button v-for="f in vm.found" :key="f.baseUrl.href" type="button"
              :class="['fdn-button', { 'fdn-selected': vm.endpointAddressText === f.baseUrl.href }]"
              :aria-pressed="vm.endpointAddressText === f.baseUrl.href" dir="auto" @click="vm.selectFound(f)">
              {{ `${f.preset?.name ?? f.baseUrl.host} (${f.baseUrl.host})` }}
            </button>
          </div>
        </section>
        <section :aria-labelledby="`${id}-presets`" class="fdn-wizard-form">
          <h3 :id="`${id}-presets`" class="fdn-label">{{ s.wizardOwnPresets }}</h3>
          <div class="fdn-wizard-presets">
            <button v-for="p in vm.presets" :key="p.id" type="button"
              :class="['fdn-button', { 'fdn-selected': vm.selectedPreset?.id === p.id }]" :aria-pressed="vm.selectedPreset?.id === p.id"
              dir="auto" @click="vm.selectPreset(p)">{{ p.name }}</button>
          </div>
        </section>
        <form class="fdn-wizard-form" novalidate @submit.prevent="submitEndpoint">
          <div class="fdn-wizard-field">
            <label :for="`${id}-endpoint`" dir="auto">{{ s.wizardOwnAddress }}</label>
            <input :id="`${id}-endpoint`" type="text" inputmode="url" autocomplete="off" :spellcheck="false" dir="ltr"
              :value="vm.endpointAddressText" :placeholder="s.wizardOwnAddressPlaceholder" data-wizard-focus
              :aria-invalid="vm.addressErrorText ? 'true' : undefined" :aria-describedby="vm.addressErrorText ? `${id}-error` : undefined"
              @input="vm.endpointAddressText = valueOf($event)">
          </div>
          <div class="fdn-wizard-check">
            <input :id="`${id}-needs-key`" type="checkbox" :checked="vm.needsKey" @change="vm.needsKey = checkedOf($event)">
            <label :for="`${id}-needs-key`" dir="auto">{{ s.wizardOwnNeedsKey }}</label>
          </div>
          <p v-if="vm.addressErrorText" :id="`${id}-error`" class="fdn-wizard-error" role="alert" dir="auto">{{ vm.addressErrorText }}</p>
          <div class="fdn-wizard-actions">
            <button v-if="vm.can.useEndpoint" type="submit" class="fdn-button fdn-primary">{{ s.wizardOwnUse }}</button>
            <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
          </div>
        </form>
      </template>

      <!-- path B: plain http in the local network -->
      <template v-else-if="vm.step === S.OwnPlainHttp">
        <p dir="auto">{{ s.wizardPlainHttpWarning }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.confirmPlainHttp" type="button" class="fdn-button fdn-primary" @click="vm.confirmPlainHttp()">{{ s.wizardPlainHttpConfirm }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </template>

      <!-- path B: the key -->
      <form v-else-if="vm.step === S.OwnKey" class="fdn-wizard-form" novalidate @submit.prevent="submitKey">
        <div class="fdn-wizard-field">
          <label :for="`${id}-key`" dir="auto">{{ s.wizardKeyLabel }}</label>
          <input :id="`${id}-key`" ref="keyInput" type="password" autocomplete="off" :spellcheck="false" dir="ltr" data-wizard-focus
            :aria-describedby="`${id}-key-help`">
        </div>
        <p :id="`${id}-key-help`" class="fdn-muted" dir="auto">{{ s.wizardKeyHelp }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.submitKey" type="submit" class="fdn-button fdn-primary">{{ s.wizardCheck }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </form>

      <!-- path B: how to allow this app -->
      <template v-else-if="vm.step === S.OwnHelp">
        <p dir="auto">{{ s.wizardOwnHelp }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.retry" type="button" class="fdn-button fdn-primary" @click="vm.retry()">{{ s.wizardTryAgain }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </template>

      <!-- path B: what the check found -->
      <template v-else-if="vm.step === S.OwnResult">
        <ul class="fdn-wizard-list">
          <li v-for="(line, i) in vm.resultLines" :key="i" dir="auto">{{ line }}</li>
        </ul>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.continue" type="button" class="fdn-button fdn-primary" @click="vm.continue()">{{ s.wizardContinue }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </template>

      <!-- path B: the model -->
      <template v-else-if="vm.step === S.OwnModel">
        <div class="fdn-wizard-field">
          <label :for="`${id}-model`" dir="auto">{{ s.wizardModelLabel }}</label>
          <select :id="`${id}-model`" :value="vm.selectedModel ?? ''" data-wizard-focus dir="ltr" @change="vm.selectedModel = valueOf($event)">
            <option v-for="m in vm.models" :key="m" :value="m" :selected="m === vm.selectedModel">{{ m }}</option>
          </select>
        </div>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.continue" type="button" class="fdn-button fdn-primary" @click="vm.continue()">{{ s.wizardContinue }}</button>
          <button v-if="vm.can.back" type="button" class="fdn-button" @click="vm.back()">{{ s.wizardBack }}</button>
        </div>
      </template>

      <!-- Settings -->
      <template v-else-if="vm.step === S.Settings">
        <p v-if="vm.connectedText" dir="auto">{{ vm.connectedText }}</p>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.connectOrganisation" type="button" class="fdn-button" @click="vm.connectOrganisation()">{{ s.wizardConnectOrganisation }}</button>
          <button v-if="vm.can.changeEndpoint" type="button" class="fdn-button" @click="vm.changeEndpoint()">{{ s.wizardChangeEndpoint }}</button>
          <button v-if="vm.can.signOut" type="button" class="fdn-button" @click="vm.signOut()">{{ ownsEndpoint ? s.wizardRemoveEndpoint : s.wizardSignOut }}</button>
          <button v-if="vm.can.close" type="button" class="fdn-button fdn-quiet" @click="vm.close()">{{ s.wizardClose }}</button>
        </div>
      </template>

      <template v-else-if="vm.step === S.SignOut">
        <p dir="auto">{{ ownsEndpoint ? s.wizardRemoveBody : s.wizardSignOutBody }}</p>
        <div class="fdn-wizard-check">
          <input :id="`${id}-chats`" type="checkbox" :checked="vm.deleteLocalChats" @change="vm.deleteLocalChats = checkedOf($event)">
          <label :for="`${id}-chats`" dir="auto">{{ s.wizardDeleteChats }}</label>
        </div>
        <div class="fdn-wizard-actions">
          <button v-if="vm.can.confirmSignOut" type="button" class="fdn-button fdn-primary" @click="vm.confirmSignOut()">{{ ownsEndpoint ? s.wizardRemoveEndpoint : s.wizardSignOut }}</button>
          <button v-if="vm.can.cancel" type="button" class="fdn-button" @click="vm.cancel()">{{ s.wizardCancel }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/** One exchange: the user's message, then the answer's parts in order. Drawn again only when this turn changes. */
import type { TurnViewModel, UiStrings } from "@fadenstack/ui";
import { turnMeta } from "@fadenstack/ui-web";

import { useViewModel } from "./composables.js";
import Icon from "./Icon.vue";
import PartView from "./PartView.js";
import Spinner from "./Spinner.vue";
import type { PartRenderer } from "./types.js";

const props = defineProps<{ turn: TurnViewModel; strings: UiStrings; renderers?: readonly PartRenderer[] | undefined }>();
const turn = useViewModel(() => props.turn);
</script>

<template>
  <article class="fdn-turn" :aria-busy="turn.isRunning">
    <div :class="turn.isPromptBlocked ? 'fdn-user fdn-user-blocked' : 'fdn-user'">
      <div class="fdn-user-bubble" dir="auto">{{ turn.userText }}<div v-if="turn.attachments.length > 0" class="fdn-chips"><span
        v-for="(a, i) in turn.attachments"
        :key="i"
        :class="a.skill ? 'fdn-chip fdn-chip-static fdn-chip-skill' : 'fdn-chip fdn-chip-static'"
        :title="a.subtitle"
      ><img v-if="a.image" class="fdn-chip-image" :src="a.image" alt="" /><Icon v-else :name="a.skill ? 'sparkle' : 'page'" :size="12" /><span
        class="fdn-chip-title"
        dir="auto"
      >{{ a.title }}</span></span></div></div>
      <div v-if="turn.isPromptBlocked" class="fdn-user-note">
        <span>{{ strings.notSent }}</span>
        <button v-if="turn.canEdit" type="button" class="fdn-link" @click="turn.edit()">{{ strings.editAndResend }}</button>
      </div>
    </div>
    <div class="fdn-answer">
      <PartView v-for="part in turn.parts" :key="part.key" :part="part" :strings="strings" :renderers="renderers" />
      <div v-if="turn.statusText" class="fdn-status">
        <Spinner v-if="turn.isRunning" />
        <span>{{ turn.statusText }}</span>
        <span v-if="turn.errorMessage" class="fdn-error-text">{{ turn.errorMessage }}</span>
      </div>
      <div v-if="!turn.isRunning && !turn.isPromptBlocked" class="fdn-turn-actions">
        <button v-if="turn.answerText" type="button" class="fdn-icon-button fdn-small" :title="strings.copy" :aria-label="strings.copy" @click="turn.copy()">
          <Icon name="copy" :size="14" />
        </button>
        <button v-if="turn.canRetry" type="button" class="fdn-icon-button fdn-small" :title="strings.retry" :aria-label="strings.retry" @click="turn.retry()">
          <Icon name="retry" :size="14" />
        </button>
        <button v-if="turn.canEdit" type="button" class="fdn-icon-button fdn-small" :title="strings.edit" :aria-label="strings.edit" @click="turn.edit()">
          <Icon name="edit" :size="14" />
        </button>
        <span class="fdn-muted">{{ turnMeta(turn) }}</span>
      </div>
    </div>
  </article>
</template>

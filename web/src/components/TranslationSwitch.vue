<script setup lang="ts">
/**
 * 原文／繁體中文（閱讀器與節點面板共用同一個選擇，只存在這個分頁的記憶體裡）。
 * 只切標題與摘要 —— 正文與點註永遠是原文（multilingual.md）。
 * 樣式借 `.tabs`／`.on`（base.css），跟 PDF 的「版面／文字」同一種：只有 `aria-pressed` 的話畫面上看不出選了哪個。
 */
import { computed } from 'vue';

import { t } from '../i18n/zh-TW';
import { useTranslationStore } from '../stores/translation-store';

const props = defineProps<{ available: boolean }>();
const translation = useTranslationStore();
const showing = computed(() => translation.translated && props.available);
</script>

<template>
  <span class="tabs" role="group" :aria-label="t.reader.translationLabel">
    <button
      type="button"
      :class="{ on: !showing }"
      :aria-pressed="!showing"
      @click="translation.translated = false"
    >
      {{ t.reader.original }}
    </button>
    <button
      type="button"
      :class="{ on: showing }"
      :aria-pressed="showing"
      :disabled="!available"
      :title="available ? undefined : t.reader.noTranslation"
      @click="translation.translated = true"
    >
      {{ t.reader.translated }}
    </button>
  </span>
  <span v-if="!available" class="muted">{{ t.reader.noTranslation }}</span>
</template>

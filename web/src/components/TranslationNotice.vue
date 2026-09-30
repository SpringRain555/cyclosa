<script setup lang="ts">
import { fill, t } from '../i18n/zh-TW';
import { when } from '../when';

defineProps<{ model: string | null; date: number | null }>();
</script>

<template>
  <p class="muted">
    {{ fill(t.reader.translationNotice, { model: model ?? '', date: when(date) }) }}
  </p>
</template>

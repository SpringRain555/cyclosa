<script setup lang="ts">
/**
 * 一條共用的頂列 —— **所以永遠知道自己在哪、回得去**（`ui-workflows.md`）。
 *
 * 設計稿的頂列是三個分頁：`[關聯圖│閱讀器│作業紀錄]`。
 * **這一版只掛得出兩個** —— 關聯圖要到 Stage 7 才有東西可指，
 * 而一個點了沒反應的分頁比少一個分頁更糟。
 */
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';

import { t } from './i18n/zh-TW';
import { useCaseStore } from './stores/case-store';

const route = useRoute();
const store = useCaseStore();

const slug = computed(() => String(route.params['slug'] ?? ''));

watch(
  slug,
  (next) => {
    if (next.length > 0) void store.open(next);
    else store.clear();
  },
  { immediate: true },
);
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="brand">{{ t.app.name }}</span>
      <span class="divider"></span>
      <RouterLink class="crumb" to="/">{{ t.nav.allCases }}</RouterLink>

      <template v-if="slug">
        <span class="sep">›</span>
        <span class="crumb current">{{ store.name }}</span>
        <nav class="tabs">
          <RouterLink :to="`/case/${encodeURIComponent(slug)}/reader`">
            {{ t.reader.tab }}
          </RouterLink>
          <RouterLink :to="`/case/${encodeURIComponent(slug)}/runs`">
            {{ t.runs.tab }}
          </RouterLink>
        </nav>
      </template>
    </header>
    <RouterView />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line-subtle);
}
.brand {
  font-weight: 600;
  letter-spacing: 0.02em;
}
.divider {
  width: 1px;
  height: 18px;
  background: var(--line);
}
.crumb {
  color: var(--text-tertiary);
  font-size: 13px;
  text-decoration: none;
}
.crumb:hover {
  color: var(--text-secondary);
}
.crumb.current {
  color: var(--text);
}
.sep {
  color: var(--text-muted);
}
.tabs {
  display: flex;
  gap: 2px;
  margin-left: 16px;
}
.tabs a {
  font-size: 13px;
  padding: 4px 12px;
  border-radius: var(--radius);
  color: var(--text-tertiary);
  text-decoration: none;
}
.tabs a:hover {
  background: var(--bg-hover);
}
/* 選取用青色，跟圖上「選取」是同一個意思、同一個顏色（ADR-0018）。 */
.tabs a.router-link-active {
  color: var(--text);
  background: var(--bg-raised);
  box-shadow: inset 0 -2px 0 var(--ring-selected);
}
</style>

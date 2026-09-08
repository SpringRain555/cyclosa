<script setup lang="ts">
/**
 * 一條共用的頂列 —— **所以永遠知道自己在哪、回得去**（`ui-workflows.md`）。
 *
 * 設計稿的頂列是三個分頁：`[關聯圖│閱讀器│作業紀錄]`，**Stage 7 起三個都在**。
 * （Stage 5–6 期間只掛得出兩個 —— 一個點了沒反應的分頁比少一個分頁更糟。）
 *
 * **設定不在那三個裡面，它在最右邊。** 理由是它不屬於任何一個專題：
 * provider 是這台機器的事實。放進分頁列會讓人以為每個專題各有一組模型設定。
 * 它 Stage 9 才出現，而在那之前不掛 —— 同一條「點了沒反應更糟」的理由。
 */
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';

import { t } from './i18n/zh-TW';
import { useCaseStore } from './stores/case-store';

const route = useRoute();
const store = useCaseStore();

const slug = computed(() => String(route.params['slug'] ?? ''));

/**
 * 分頁的選取狀態**自己算，不用 `router-link-active`**。
 *
 * 關聯圖的路徑是 `/case/:slug`，而它是另外兩頁的前綴 ——
 * `router-link-active` 是前綴比對，所以在閱讀器上關聯圖那一格也會亮。
 * 改用 `exact` 又會讓閱讀器在 `/reader/:itemId` 上不亮。**兩邊都不對，所以自己算。**
 */
const tabs = computed(() => {
  const base = `/case/${encodeURIComponent(slug.value)}`;
  return [
    { to: base, label: t.graph.tab, on: route.name === 'graph' },
    { to: `${base}/reader`, label: t.reader.tab, on: route.name === 'reader' },
    { to: `${base}/runs`, label: t.runs.tab, on: route.name === 'runs' },
  ];
});

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
          <RouterLink
            v-for="tab in tabs"
            :key="tab.to"
            :to="tab.to"
            :class="{ on: tab.on }"
            active-class=""
            exact-active-class=""
          >
            {{ tab.label }}
          </RouterLink>
        </nav>
      </template>

      <RouterLink class="settings-link" to="/settings" active-class="on" exact-active-class="on">
        {{ t.nav.settings }}
      </RouterLink>
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
.tabs a.on {
  color: var(--text);
  background: var(--bg-raised);
  box-shadow: inset 0 -2px 0 var(--ring-selected);
}
/* 設定靠最右 —— 它不屬於分頁列那一組（它跟專題無關）。 */
.settings-link {
  margin-left: auto;
  font-size: 13px;
  padding: 4px 12px;
  border-radius: var(--radius);
  color: var(--text-tertiary);
  text-decoration: none;
}
.settings-link:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.settings-link.on {
  color: var(--text);
  background: var(--bg-raised);
}
</style>

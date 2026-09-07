<script setup lang="ts">
/**
 * 一條共用的頂列 —— **所以永遠知道自己在哪、回得去**（`ui-workflows.md`）。
 *
 * Stage 5 只有專題清單這一層，所以頂列現在只有品牌與「全部專題」。
 * 三個分頁（關聯圖／閱讀器／作業紀錄）在 Stage 7 之後才會有東西可指。
 */
import { t } from './i18n/zh-TW';
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="brand">{{ t.app.name }}</span>
      <span class="divider"></span>
      <span class="crumb">{{ t.nav.allCases }}</span>
    </header>
    <RouterView />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
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
}
</style>

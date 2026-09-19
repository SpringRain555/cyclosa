<script setup lang="ts">
/**
 * 一條共用的頂列 —— **所以永遠知道自己在哪、回得去**（`ui-workflows.md`）。
 *
 * 設計稿的頂列是三個分頁：`[關聯圖│閱讀器│作業紀錄]`，**v0.3.0 起三個都在**。
 * （v0.1.0–v0.2.0 期間只掛得出兩個 —— 一個點了沒反應的分頁比少一個分頁更糟。）
 *
 * **設定不在那三個裡面，它在最右邊。** 理由是它不屬於任何一個專題：
 * provider 是這台機器的事實。放進分頁列會讓人以為每個專題各有一組模型設定。
 * 它 v0.5.0 才出現，而在那之前不掛 —— 同一條「點了沒反應更糟」的理由。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { api } from './api';
import { fill, t } from './i18n/zh-TW';
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

/**
 * 模型這一塊現在能不能用。**要在按下去之前看得到，不是想起來的時候。**
 *
 * 這裡刻意不開一個新分頁：頂列那三格是「目的地」，
 * 而模型是一個**狀態**，狀態該常駐、不該佔一個目的地。
 *
 * **v0.24.0 起是一個點，不是那串模型名。** 三個角色都設好之後那串佔 32ch，
 * 在 768px 寬的畫面上把「結束 Cyclosa」推出去；而且四個任務各接各的連線之後，
 * 一串名字也說不清「哪一件事跑在哪」—— 那是設定頁的事。這裡只回答一個問題：
 * 現在按下擴展會不會停手。點的形狀是第二重編碼（實心／空心／虛線），不只靠顏色。
 *
 * 讀的是 `/api/providers`，而那一支不會產生費用
 * （agent 只跑 `--version`、chat 只讀 `/api/tags`）。
 */
type ModelState = 'ready' | 'none' | 'problem';
const modelState = ref<ModelState>('none');

/**
 * 結束 Cyclosa。
 *
 * **不掛 `beforeunload`**：關掉分頁不該關掉伺服器 ——
 * 你可能開了兩個分頁，也可能是誤關，而那個事件本來就不保證送得出去。
 * 關掉程式要是一個明確的動作。
 */
const quitting = ref(false);
const quitMessage = ref<string | null>(null);
/**
 * 關掉了 —— 整頁換成結束畫面。**這一頁上其餘的東西全部已經失效。**
 *
 * **這一頁上沒有「關閉這個分頁」的按鈕。** v0.22.0 給過一顆（試 `window.close()`，
 * 關不成就解釋為什麼），而它在使用者的瀏覽器上就是關不成 —— 瀏覽器只讓腳本關掉
 * 「腳本自己開的」分頁，這一個是啟動器用網址開的。一顆按了沒反應的按鈕，
 * 再多一句「沒反應是正常的」也還是一顆壞掉的按鈕（2026-09-18 使用者回報）。
 * 結束畫面現在只說一句話：可以關掉這個分頁了。
 */
const quitDone = ref(false);

async function quit(): Promise<void> {
  quitting.value = true;
  const probe = await api.shutdown(false);
  if (!probe.ok) {
    quitting.value = false;
    quitMessage.value = t.shutdown.failed;
    return;
  }

  // **一律確認**，而有作業在跑的時候那句話要說出那個數字。
  const message =
    probe.data.activeRuns > 0
      ? fill(t.shutdown.confirmBusy, { n: probe.data.activeRuns })
      : t.shutdown.confirmIdle;
  if (!window.confirm(message)) {
    quitting.value = false;
    return;
  }

  const done = await api.shutdown(true);
  if (!done.ok) {
    quitting.value = false;
    quitMessage.value = t.shutdown.failed;
    return;
  }

  // **整頁換掉，不是加一句提示。**
  // 伺服器沒了之後，這一頁上每一顆按鈕都還看起來能按 —— 按下去才發現連不上。
  // 關分頁這件事**不自動做**：它多半會被瀏覽器忽略，而一個「有時有效」的
  // 自動行為比沒有更難理解。給一顆按鈕，讓使用者按下去的時候知道自己在做什麼。
  quitDone.value = true;
  quitMessage.value = null;
}

onMounted(async () => {
  const r = await api.providers();
  if (!r.ok) return;
  // 一個任務都沒設定 → 空心；設了但有一個跑不動（連不上、缺能力）→ 虛線；否則實心。
  const configured = r.data.tasks.filter((row) => row.state !== 'not-configured');
  if (configured.length === 0) modelState.value = 'none';
  else modelState.value = configured.every((row) => row.ok) ? 'ready' : 'problem';
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
  <!--
    關掉之後的整頁畫面。**取代原本的畫面，不是疊在上面** ——
    伺服器沒了，那一頁上每一顆按鈕都還看起來能按。
  -->
  <div v-if="quitDone" class="shell farewell">
    <div class="farewell-box">
      <h1>{{ t.shutdown.doneTitle }}</h1>
      <p>{{ t.shutdown.doneBody }}</p>
    </div>
  </div>

  <div v-else class="shell">
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

      <RouterLink
        class="settings-link"
        to="/settings"
        active-class="on"
        exact-active-class="on"
        :title="t.settings.topbar[modelState]"
      >
        <span :class="['model-dot', modelState]" aria-hidden="true"></span>
        <span class="model-state">{{ t.settings.topbar[modelState] }}</span>
        {{ t.nav.settings }}
      </RouterLink>

      <!--
        結束 Cyclosa。**二次確認的門在伺服器端** ——
        第一次呼叫只回「有幾個作業在跑」，帶了 force 才真的關。
        只做在畫面上的話，它就是一個繞得過的提醒，
        而這顆按鈕會讓正在跑的抓取中斷。
      -->
      <button class="quit" type="button" :disabled="quitting" @click="quit">
        {{ t.shutdown.open }}
      </button>
    </header>

    <p v-if="quitMessage" class="quit-note">{{ quitMessage }}</p>
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
/**
 * **這一列上只有一個東西可以被壓縮：專題名稱。**
 *
 * flex 子項預設 `min-width: auto`，所以它們**不會縮到比內容窄** ——
 * 一個長專題名會把右邊的「設定」與「結束 Cyclosa」整個推出畫面，
 * 而那兩顆是這一列上最不能不見的東西（一個是出口，一個是關機）。
 *
 * 所以下面每一格都標了 `flex: none`，只有 `.crumb.current` 可以縮，
 * 縮到放不下就變成刪節號。
 */
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
.topbar > * {
  flex: none;
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
  font-size: var(--fs-small);
  text-decoration: none;
}
.crumb:hover {
  color: var(--text-secondary);
}
/* **這一列上唯一可以被壓縮的東西。** 專題名稱多長都不該把出口推出畫面。 */
.crumb.current {
  color: var(--text);
  flex: 0 1 auto;
  min-width: 4ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sep {
  color: var(--text-muted);
}
/* 分頁列的樣子在 base.css；這裡只管它在頂列上的位置。 */
.tabs {
  margin-left: 16px;
}
/**
 * 模型狀態的點，常駐在設定連結旁邊 —— **狀態不佔一個目的地。**
 * 形狀是第二重編碼（ADR-0018 規則 2）：實心＝可以用、空心＝還沒設定、虛線＝有問題。
 * 窄畫面只留點，那句話進 title —— 2026-09-18 量到那串模型名在 768px 把結束鍵推出畫面。
 */
.model-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--text-tertiary);
  vertical-align: middle;
  margin-right: 6px;
}
.model-dot.ready {
  background: var(--ui-success);
  border-color: var(--ui-success);
}
.model-dot.problem {
  border-style: dashed;
  border-color: var(--edge-pending);
}
.model-state {
  color: var(--text-muted);
  font-size: var(--fs-label);
  margin-right: 8px;
}
@media (max-width: 1023px) {
  .model-state {
    display: none;
  }
}

/* 設定靠最右 —— 它不屬於分頁列那一組（它跟專題無關）。 */
/* 結束是一個**離開**的動作，所以它在最右邊、而且平常很輕。
   一顆跟「設定」一樣顯眼的結束鍵，會讓人以為那是常用的下一步。 */
.quit {
  font: inherit;
  font-size: var(--fs-label);
  padding: 4px 10px;
  margin-left: 10px;
  /* **不換行。** 換成兩行的話它會比 44px 的頂列高，整條線就歪了
     （實測 768px 寬時這顆變成 48px 高）。 */
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.quit:hover:not(:disabled) {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.quit:disabled {
  opacity: 0.5;
  cursor: default;
}
.quit-note {
  margin: 0;
  padding: 10px 16px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line-subtle);
}

/** 結束畫面：置中、不留任何可以按的東西，除了那顆關分頁。 */
.farewell {
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.farewell-box {
  max-width: 460px;
  text-align: center;
}

.farewell-box h1 {
  margin: 0 0 12px;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--text);
}

.farewell-box p {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.7;
  color: var(--text-secondary);
}

.settings-link {
  margin-left: auto;
  font-size: var(--fs-small);
  padding: 4px 12px;
  border-radius: var(--radius);
  color: var(--text-tertiary);
  text-decoration: none;
  white-space: nowrap;
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

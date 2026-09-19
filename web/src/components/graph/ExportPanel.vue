<script setup lang="ts">
/**
 * 證據包匯出。
 *
 * ## 這個面板要在按下去之前說清楚兩件事
 *
 * 1. **範圍是「你現在看到的這一塊」** —— 不是整個專題。
 *    一個以為自己匯出了全部的人，不會回頭檢查為什麼少了幾條。
 * 2. **它會在磁碟上產生檔案。** 所以匯出完成之後第一個顯示的是**位置**，
 *    而不是一句「完成」。
 *
 * ## 三個數字要分開講
 *
 * 已核對／位置已移動／回溯不到 —— 它們對使用者的意思完全不同：
 * 第一個什麼都不用做，第二個是正文重算過（引文仍然成立），
 * 而**第三個代表那一條的出處驗不了**。
 * 合成一個「匯出了 18 條引文」就把第三種藏起來了。
 */
import { ref } from 'vue';

import { api, type ApiError, type ExportSummary } from '../../api';
import { fill, t } from '../../i18n/zh-TW';
import ErrorPanel from '../ErrorPanel.vue';

const props = defineProps<{
  slug: string;
  query: Record<string, string>;
  hops: number;
  nodeCount: number;
  edgeCount: number;
}>();

const busy = ref(false);
const error = ref<ApiError | null>(null);
const result = ref<ExportSummary | null>(null);
const copied = ref(false);

async function run(): Promise<void> {
  busy.value = true;
  error.value = null;
  const r = await api.exportEvidence(props.slug, props.query);
  busy.value = false;
  if (!r.ok) {
    error.value = r.error;
    result.value = null;
    return;
  }
  result.value = r.data;
  copied.value = false;
}

async function copyPath(): Promise<void> {
  const folder = result.value?.folder;
  if (folder === undefined) return;
  try {
    await navigator.clipboard.writeText(folder);
    copied.value = true;
  } catch {
    // 剪貼簿被瀏覽器擋掉不是錯誤 —— 路徑就在畫面上，選起來複製一樣可以。
    copied.value = false;
  }
}
</script>

<template>
  <section class="export">
    <h3>{{ t.exportPack.title }}</h3>
    <p class="hint">{{ t.exportPack.intro }}</p>

    <p class="scope">{{ fill(t.exportPack.scope, { hops, nodes: nodeCount }) }}</p>
    <p class="hint">{{ t.exportPack.scopeNote }}</p>
    <p v-if="edgeCount === 0" class="hint">{{ t.exportPack.noEdges }}</p>

    <ErrorPanel v-if="error" :error="error" />

    <button :disabled="busy" @click="run">
      {{ busy ? t.exportPack.busy : t.exportPack.run }}
    </button>

    <div v-if="result" class="result">
      <p class="done">{{ t.exportPack.done }}</p>

      <p class="label">{{ t.exportPack.folder }}</p>
      <p class="path mono">{{ result.folder }}</p>
      <button class="small" @click="copyPath">
        {{ copied ? t.exportPack.copied : t.exportPack.copyPath }}
      </button>

      <ul class="files mono">
        <li v-for="file in result.files" :key="file">{{ file }}</li>
      </ul>

      <p class="counts">
        {{
          fill(t.exportPack.counts, {
            nodes: result.nodeCount,
            edges: result.edgeCount,
            quotes: result.quoteCount,
          })
        }}
      </p>
      <p class="counts">
        {{ fill(t.exportPack.sources, { sources: result.sourceCount, notes: result.noteCount }) }}
      </p>

      <!-- 三個數字分開，而且不合成一個總數。 -->
      <p v-if="result.quoteCount > 0" :class="['breakdown', { warn: result.missing > 0 }]">
        {{
          fill(t.exportPack.quoteBreakdown, {
            verified: result.verified,
            shifted: result.shifted,
            missing: result.missing,
          })
        }}
      </p>

      <p v-if="result.shifted > 0" class="hint">{{ t.exportPack.shiftedWhy }}</p>
      <p v-if="result.missing > 0" class="warn-note">{{ t.exportPack.missingWhy }}</p>
      <p v-if="result.projectedOmitted > 0" class="hint">
        {{ fill(t.exportPack.projected, { n: result.projectedOmitted }) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.export {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.export h3 {
  font-size: var(--fs-small);
}

.hint,
.scope,
.counts,
.breakdown,
.warn-note,
.label {
  margin: 0;
  font-size: var(--fs-label);
  line-height: 1.7;
  color: var(--text-tertiary);
}

.scope {
  color: var(--text-secondary);
}

.label {
  color: var(--text-muted);
}

.path {
  margin: 0;
  font-size: var(--fs-label);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-all;
  user-select: all;
}

.mono {
  font-family: ui-monospace, monospace;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px solid var(--line-subtle);
  padding-top: 8px;
  margin-top: 2px;
}

.done {
  margin: 0;
  font-size: var(--fs-label);
  color: var(--text);
}

.files {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--fs-label);
  color: var(--text-muted);
}

/* 回溯不到的時候用琥珀 —— 綠色在這個工具裡只有「確認」一個意思，
   而紅色只在面板上代表一個動作失敗（ADR-0018）。這裡兩者都不是。 */
.breakdown.warn,
.warn-note {
  color: var(--edge-pending);
}

/* 按鈕在 base.css；這一欄只決定它靠左、不撐滿。 */
.export button {
  align-self: flex-start;
}
</style>

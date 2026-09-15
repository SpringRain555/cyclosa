<script setup lang="ts">
/**
 * 在這個專題裡搜尋。**三種模式：全文／語意／兩者。**
 *
 * ## 為什麼結果會標「可能是誤中」
 *
 * 中文走的是 bigram 索引，而它會跨詞誤中：查「台積電」切成「台積」與「積電」
 * 兩個 gram，一份寫著「來台積極…累積電力」的文件兩個 gram 都有 ——
 * 索引裡沒有位置，**分不出來**。
 *
 * 所以伺服器拿到候選之後回去讀正文，而三種結果各自有一句話：
 *
 * | | 畫面上 |
 * |---|---|
 * | `hit` | 摘要裡把命中的那幾個字標起來 |
 * | `semantic` | **「用字不同，但講的是同一件事」** ＋ 顯示真正命中的那一段 |
 * | `miss` | **「可能是誤中」** —— 正文裡沒有這串字 |
 * | `no-text` | 「正文不在，沒驗」—— 那是不知道，不是不對 |
 *
 * 把後三種混成同一句話，就等於對一份只是正文被清掉的資料說謊，
 * **也等於對一個語意上完全正確的結果指控它是誤中**。
 *
 * ## 結果點下去是「跳到圖上」，不是開一個新畫面
 *
 * 這個面板開在關聯圖的左欄，而搜尋在這個工具裡的用途是**找到某個東西附近有什麼** ——
 * 所以點一筆就是把焦點移過去，圖跟著重畫。要讀內容再按「在閱讀器開啟」。
 */
import { ref } from 'vue';

import {
  api,
  type ApiError,
  type BackfillReport,
  type SearchHit,
  type SearchMode,
  type SearchResponse,
} from '../../api';
import { fill, t } from '../../i18n/zh-TW';
import ErrorPanel from '../ErrorPanel.vue';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{
  (e: 'focus', id: string): void;
  (e: 'open-reader', itemId: string): void;
}>();

const q = ref('');
const busy = ref(false);
const error = ref<ApiError | null>(null);
const result = ref<SearchResponse | null>(null);

/**
 * 搜尋模式。**預設是 `text`。**
 *
 * 語意檢索要一個設定好的嵌入模型，而多數人剛打開這個工具時還沒設 ——
 * 預設走語意的話，第一次搜尋會拿到一句「沒設定嵌入模型」而不是結果。
 */
const mode = ref<SearchMode>('text');
const MODES: readonly SearchMode[] = ['text', 'semantic', 'hybrid'];

/**
 * 建立語意索引。**這顆按鈕在這裡而不是設定頁**，因為向量是逐專題的，
 * 而使用者發現「語意查不到東西」的地方就是這一格。
 *
 * 一次一批（伺服器端 60 份），做完回報還剩幾份 —— 所以這裡是一個迴圈。
 * **不是一個 `run`**：它的續跑點就是「還有哪些沒有向量」，
 * 中斷之後再按一次就從那裡接下去，所以不需要取消與復原（`embed-service`）。
 */
const backfill = ref<BackfillReport | null>(null);
const building = ref(false);

async function build(): Promise<void> {
  building.value = true;
  error.value = null;
  /**
   * **停止條件有四個，而第四個是最重要的。**
   *
   * 前三個是正常的結束：做完了、沒有東西可做、出錯了。
   * 第四個是 `remaining` **沒有變少** —— 那代表有一份資料
   * 「處理過了但還是沒有向量」，而它下一批仍然會被選中。
   *
   * 2026-09-10 真的發生過：一份 97 個字的資料切不出任何一段，
   * 於是 `processed` 每次都是 1、`written` 每次都是 0、`remaining` 不動。
   * 切段那一側已經修好（保底至少一段），**而這個迴圈仍然要自己收斂** ——
   * 一個只在對方乖乖回話時才會停的迴圈，是靠對方守的規則。
   */
  let previous = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const r = await api.embedBackfill(props.slug);
    if (!r.ok) {
      error.value = r.error;
      break;
    }
    backfill.value = r.data;
    if (r.data.remaining === 0 || r.data.processed === 0 || r.data.code !== null) break;
    if (r.data.remaining >= previous) break;
    previous = r.data.remaining;
  }
  building.value = false;
}

async function run(): Promise<void> {
  const query = q.value.trim();
  if (query.length === 0) return;
  busy.value = true;
  error.value = null;
  const r = await api.search(props.slug, query, mode.value);
  busy.value = false;
  if (!r.ok) {
    error.value = r.error;
    result.value = null;
    return;
  }
  result.value = r.data;
}

function pick(hit: SearchHit): void {
  emit('focus', hit.id);
}

/**
 * 這一筆是什麼東西。
 *
 * `item.kind` 的六個值在 schema 的 CHECK 裡列著，六個都有中文 ——
 * 走到最後那一行代表資料庫加了第七種而這裡沒跟上，
 * **那時顯示原值比顯示空白好**：它至少說得出哪裡對不上。
 */
type KindKey = keyof typeof t.search.kinds;

function kindLabel(hit: SearchHit): string {
  if (hit.kind === 'entity') return t.search.entity;
  const key = hit.itemKind ?? 'web';
  return key in t.search.kinds ? t.search.kinds[key as KindKey] : key;
}

/** 摘要切成三段：命中前、命中、命中後。**位置是伺服器給的** —— 前端自己再找一次
 *  會找到摘要裡另一個同樣的字，於是上色的不是命中的那一個。 */
function parts(hit: SearchHit): { before: string; match: string; after: string } {
  if (hit.check !== 'hit' || hit.matchEnd <= hit.matchStart) {
    return { before: hit.snippet, match: '', after: '' };
  }
  return {
    before: hit.snippet.slice(0, hit.matchStart),
    match: hit.snippet.slice(hit.matchStart, hit.matchEnd),
    after: hit.snippet.slice(hit.matchEnd),
  };
}
</script>

<template>
  <section class="search">
    <h3>{{ t.search.title }}</h3>

    <form class="row" @submit.prevent="run">
      <input v-model="q" type="text" :placeholder="t.search.placeholder" :disabled="busy" />
      <button type="submit" :disabled="busy || q.trim().length === 0">
        {{ busy ? t.search.busy : t.search.run }}
      </button>
    </form>

    <!-- **模式是三顆並排的按鈕，不是下拉選單。**
       三個選項而且每次搜尋都可能想換 —— 下拉選單要兩次點擊才換得掉。 -->
    <div class="modes">
      <button
        v-for="m in MODES"
        :key="m"
        type="button"
        :class="{ on: mode === m }"
        :disabled="busy"
        @click="mode = m"
      >
        {{ t.search.modes[m] }}
      </button>
    </div>
    <p class="hint">{{ t.search.modeWhat[mode] }}</p>

    <!-- **語意要有向量才查得到東西**，而「沒有向量」是一個安靜的狀態 ——
       所以要求語意的時候就把它攤開，不要等到查不到才問為什麼。 -->
    <div v-if="mode !== 'text'" class="build">
      <button type="button" :disabled="building" @click="build">
        {{ building ? t.search.building : t.search.build }}
      </button>
      <span v-if="backfill && backfill.model === null" class="hint">
        {{ t.search.embedNoModel }}
      </span>
      <span v-else-if="backfill" class="hint">
        {{
          backfill.remaining > 0
            ? fill(t.search.buildLeft, { n: backfill.remaining, rows: backfill.rows })
            : fill(t.search.buildDone, { rows: backfill.rows, owners: backfill.owners })
        }}
      </span>
    </div>

    <ErrorPanel v-if="error" :error="error" />

    <template v-if="result">
      <p class="hint">
        {{ fill(t.search.summary, { n: result.hits.length, ms: result.tookMs }) }}
      </p>

      <!-- notice 不是錯誤：結果照常回，只是要說出它可能不完整 -->
      <p v-if="result.notices.includes('SEARCH_INDEX_INCOMPLETE')" class="notice">
        {{ t.search.incomplete }}
      </p>
      <p v-if="result.notices.includes('SEARCH_EMBED_UNAVAILABLE')" class="notice">
        {{ t.search.embedUnavailable }}
      </p>

      <p v-if="result.hits.length === 0" class="hint">{{ t.search.empty }}</p>

      <ul v-else class="hits">
        <li v-for="hit in result.hits" :key="`${hit.kind}-${hit.id}`" :class="hit.check">
          <button type="button" class="hit" @click="pick(hit)">
            <span class="head">
              <span class="title">{{ hit.title }}</span>
              <span class="tag">{{ kindLabel(hit) }}</span>
            </span>
            <span class="snippet">
              <span v-if="hit.cutHead">…</span>{{ parts(hit).before
              }}<mark v-if="parts(hit).match">{{ parts(hit).match }}</mark
              >{{ parts(hit).after }}<span v-if="hit.cutTail">…</span>
            </span>
            <span v-if="hit.check === 'semantic'" class="why">{{ t.search.semantic }}</span>
            <span v-else-if="hit.check === 'miss'" class="why">{{ t.search.miss }}</span>
            <span v-else-if="hit.check === 'no-text'" class="why">{{ t.search.noText }}</span>
          </button>
          <button
            v-if="hit.kind === 'item'"
            type="button"
            class="small"
            @click="emit('open-reader', hit.id)"
          >
            {{ t.search.openReader }}
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.search {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

h3 {
  margin: 0;
  font-size: 13px;
}

.row {
  display: flex;
  gap: 6px;
}

.build {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.build button {
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

/** 模式那三顆 —— **等寬**，因為它們是同一個決定的三個選項。 */
.modes {
  display: flex;
  gap: 4px;
}

.modes button {
  flex: 1;
  font: inherit;
  font-size: 11px;
  padding: 3px 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.modes button.on {
  border-color: var(--ui-selected);
  color: var(--text);
}

.row input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text);
}

.row input:focus {
  outline: none;
  border-color: var(--ui-action);
}

.row button,
.small {
  font: inherit;
  font-size: 11px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-secondary);
  cursor: pointer;
}

.hint,
.notice,
.why {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-tertiary);
}

.notice {
  color: var(--edge-pending);
}

.hits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 46vh;
  overflow-y: auto;
}

.hits li {
  display: flex;
  flex-direction: column;
  padding: 6px 4px;
  border-bottom: 1px solid var(--line-subtle);
}

/* **驗不過的那些不是紅色的。** 它們仍然可能是使用者要的東西 ——
   只是這一列的可信度比較低，所以整列淡一階、並且底下寫一句為什麼。 */
.hits li.miss,
.hits li.no-text {
  opacity: 0.62;
}

.hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  cursor: pointer;
}

.head {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.title {
  font-size: 12px;
  color: var(--text);
}

.tag {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.snippet {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

/* 命中的字**用底線與字重標，不用顏色** —— 這個面板疊在關聯圖上，
   而圖上的每一個顏色都已經有一個意思了（ADR-0018 規則 1）。 */
mark {
  background: none;
  color: var(--text);
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.small {
  align-self: flex-start;
  margin-top: 4px;
}
</style>

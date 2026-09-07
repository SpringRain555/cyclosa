<script setup lang="ts">
/**
 * 閱讀器。**這一頁回答：「這份到底寫了什麼，而我能不能信它」**（ui-workflows）。
 *
 * ## 正文為什麼是純文字段落，不是重構後的 HTML
 *
 * 抓回來的 HTML 是**外部輸入**，而這一頁跑在 `127.0.0.1:7433` ——
 * 跟 API 同一個 origin。把它 `v-html` 進來，那份頁面的腳本就能打我們的 API。
 * Readability 會拿掉 `<script>`，但它不是消毒器，也沒有宣稱自己是。
 *
 * 要顯示完整排版得先引一個消毒器（DOMPurify 之類），而那是一個要查授權、
 * 要驗、要維護的新依賴 —— **是一個獨立的決定，不是這一階段順手做的事**。
 * 在那之前：正文顯示純文字段落，而**「看原始快照」給的是完整的原件**
 * （那一條走 `sandbox` ＋ CSP，在瀏覽器層隔離）。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, type DerivedPayload, type Item, type ItemDetail } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';
import LowConfidenceBadge from '../components/LowConfidenceBadge.vue';

const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params['slug'] ?? ''));
const itemId = computed(() => {
  const raw = route.params['itemId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const list = ref<Item[]>([]);
const nextCursor = ref<string | null>(null);
const sort = ref<'recent' | 'title'>('recent');
const filter = ref<'all' | 'low' | 'unread'>('all');
const listError = ref<import('../api').ApiError | null>(null);

const detail = ref<ItemDetail | null>(null);
const derived = ref<DerivedPayload | null>(null);
const detailError = ref<import('../api').ApiError | null>(null);
const page = ref(1);
const loading = ref(false);

function query(cursor?: string): Record<string, string> {
  const q: Record<string, string> = { sort: sort.value, limit: '50' };
  if (cursor !== undefined) q['cursor'] = cursor;
  if (filter.value === 'low') q['low'] = '1';
  if (filter.value === 'unread') q['unread'] = '1';
  return q;
}

async function loadList(append = false): Promise<void> {
  const result = await api.items(
    slug.value,
    query(append ? (nextCursor.value ?? undefined) : undefined),
  );
  if (!result.ok) {
    listError.value = result.error;
    return;
  }
  listError.value = null;
  list.value = append ? [...list.value, ...result.data.items] : result.data.items;
  nextCursor.value = result.data.nextCursor;
}

async function loadDetail(): Promise<void> {
  const id = itemId.value;
  detail.value = null;
  derived.value = null;
  detailError.value = null;
  page.value = 1;
  if (id === null) return;

  loading.value = true;
  const [meta, content] = await Promise.all([
    api.item(slug.value, id),
    api.itemContent(slug.value, id),
  ]);
  loading.value = false;

  if (!meta.ok) {
    detailError.value = meta.error;
    return;
  }
  detail.value = meta.data;
  if (content.ok) derived.value = content.data.derived;

  // **開起來就是讀過了。** 已讀是正交旗標，不是狀態轉移 —— 它不影響管線。
  if (meta.data.item.readAt === null) {
    const marked = await api.markRead(slug.value, id, true);
    if (marked.ok) {
      const row = list.value.find((i) => i.id === id);
      if (row !== undefined) row.readAt = marked.data;
    }
  }
}

watch([slug, sort, filter], () => void loadList(), { immediate: true });
watch(itemId, () => void loadDetail(), { immediate: true });

function open(id: string): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/reader/${encodeURIComponent(id)}`);
}

const paragraphs = computed(() => {
  const d = derived.value;
  if (d === null) return [];
  const text = d.kind === 'pdf' ? (d.pages?.[page.value - 1] ?? '') : d.text;
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
});

const snapshotUrl = computed(() =>
  detail.value === null ? '' : api.snapshotUrl(slug.value, detail.value.item.id),
);

function humanSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('zh-Hant');
}

async function act(action: 'exclude' | 'restore' | 'retry'): Promise<void> {
  const id = itemId.value;
  if (id === null) return;
  const result = await api.itemAction(slug.value, id, action);
  if (!result.ok) {
    detailError.value = result.error;
    return;
  }
  await loadList();
  await loadDetail();
}
</script>

<template>
  <main class="reader">
    <aside class="list">
      <header class="list-head">
        <h2>{{ t.reader.listTitle }}</h2>
        <div class="controls">
          <select v-model="sort" :aria-label="t.reader.sortRecent">
            <option value="recent">{{ t.reader.sortRecent }}</option>
            <option value="title">{{ t.reader.sortTitle }}</option>
          </select>
          <select v-model="filter" :aria-label="t.reader.filterAll">
            <option value="all">{{ t.reader.filterAll }}</option>
            <option value="low">{{ t.reader.filterLowConfidence }}</option>
            <option value="unread">{{ t.reader.filterUnread }}</option>
          </select>
        </div>
      </header>

      <ErrorPanel v-if="listError" :error="listError" retryable @retry="loadList()" />
      <p v-else-if="list.length === 0" class="muted empty">{{ t.reader.empty }}</p>

      <ul v-else class="rows">
        <li v-for="row in list" :key="row.id">
          <button
            class="row"
            :class="{ active: row.id === itemId, read: row.readAt !== null }"
            @click="open(row.id)"
          >
            <span class="row-title">{{ row.title }}</span>
            <span class="row-meta">
              <span class="kind">{{ row.kind }}</span>
              <span v-if="row.status !== 'included'" class="status">
                {{ t.itemStatus[row.status] }}
              </span>
              <LowConfidenceBadge
                v-if="row.lowConfidence"
                compact
                :reasons="row.lowConfidenceReasons"
              />
            </span>
          </button>
        </li>
      </ul>

      <button v-if="nextCursor" class="more" @click="loadList(true)">
        {{ t.reader.loadMore }}
      </button>
    </aside>

    <section class="pane">
      <p v-if="loading" class="muted">{{ t.common.loading }}</p>
      <ErrorPanel v-else-if="detailError" :error="detailError" />
      <p v-else-if="detail === null" class="muted pick">{{ t.reader.pickOne }}</p>

      <article v-else>
        <header class="doc-head">
          <p class="position">
            {{
              fill(t.reader.position, {
                index: detail.position.index,
                total: detail.position.total,
              })
            }}
          </p>
          <h1>{{ detail.item.title }}</h1>

          <dl class="facts">
            <template v-if="detail.item.sourceUrl">
              <dt>{{ t.reader.source }}</dt>
              <dd>
                <a :href="detail.item.sourceUrl" target="_blank" rel="noreferrer noopener">
                  {{ detail.item.sourceUrl }}
                </a>
              </dd>
            </template>
            <template v-if="detail.item.fetchedAt">
              <dt>{{ t.reader.fetchedAt }}</dt>
              <dd>{{ when(detail.item.fetchedAt) }}</dd>
            </template>
            <dt>{{ t.reader.language }}</dt>
            <dd>{{ detail.item.lang === 'und' ? t.reader.unknownLanguage : detail.item.lang }}</dd>
            <template v-if="detail.item.byteSize">
              <dt>{{ t.reader.size }}</dt>
              <dd>{{ humanSize(detail.item.byteSize) }}</dd>
            </template>
          </dl>

          <div class="actions">
            <a
              v-if="detail.item.sha256"
              class="btn"
              :href="snapshotUrl"
              target="_blank"
              rel="noreferrer noopener"
            >
              {{ t.reader.openSnapshot }}
            </a>
            <!-- **原文／繁中切換要有譯文才有意義。** 這一版沒有翻譯，
                 所以按鈕是關的，而旁邊寫著為什麼 —— 不是一個按了沒反應的按鈕。 -->
            <button disabled>{{ t.reader.translated }}</button>
            <span class="muted note">{{ t.reader.noTranslation }}</span>
          </div>

          <div class="actions">
            <button v-if="detail.item.status === 'excluded'" @click="act('restore')">
              {{ t.reader.restore }}
            </button>
            <button v-else @click="act('exclude')">{{ t.reader.exclude }}</button>
            <button
              v-if="detail.item.status === 'failed' && detail.item.requestedUrl"
              @click="act('retry')"
            >
              {{ t.reader.retry }}
            </button>
          </div>
        </header>

        <p v-if="detail.item.status === 'excluded'" class="notice">{{ t.reader.excluded }}</p>
        <p v-if="detail.item.status === 'failed'" class="notice">{{ t.reader.failedNotice }}</p>

        <LowConfidenceBadge
          v-if="detail.item.lowConfidence"
          :reasons="detail.item.lowConfidenceReasons"
        />

        <div v-if="detail.item.kind === 'image'" class="image-wrap">
          <p class="muted">{{ t.reader.imageOnly }}</p>
          <img :src="snapshotUrl" :alt="detail.item.title" />
        </div>

        <template v-else-if="derived">
          <nav v-if="derived.kind === 'pdf' && derived.pages" class="pages">
            <button :disabled="page <= 1" @click="page--">{{ t.reader.previous }}</button>
            <span>{{ fill(t.reader.page, { n: page }) }}</span>
            <button :disabled="page >= derived.pages.length" @click="page++">
              {{ t.reader.next }}
            </button>
            <span class="muted">{{ fill(t.reader.pages, { n: derived.pages.length }) }}</span>
          </nav>

          <p v-if="paragraphs.length === 0" class="muted">{{ t.reader.noContent }}</p>
          <p v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</p>
        </template>

        <p v-else class="muted">{{ t.reader.noContent }}</p>

        <nav class="neighbours">
          <button
            :disabled="!detail.neighbours.previous"
            @click="open(detail.neighbours.previous!)"
          >
            {{ t.reader.previous }}
          </button>
          <button :disabled="!detail.neighbours.next" @click="open(detail.neighbours.next!)">
            {{ t.reader.next }}
          </button>
        </nav>
      </article>
    </section>
  </main>
</template>

<style scoped>
.reader {
  display: grid;
  grid-template-columns: minmax(240px, 320px) 1fr;
  height: 100%;
  min-height: 0;
}
.list {
  border-right: 1px solid var(--line-subtle);
  overflow-y: auto;
  padding: 12px;
  background: var(--bg-panel);
}
.list-head h2 {
  font-size: 14px;
  margin: 0 0 8px;
}
.controls {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
select {
  font: inherit;
  flex: 1;
  background: var(--bg-app);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 5px 6px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius);
}
.row:hover {
  background: var(--bg-hover);
}
.row.active {
  border-color: var(--ring-selected);
  background: var(--bg-raised);
}
/* 已讀＝灰色內環的平面版：左邊一條灰線。**明暗不表示程度**，這是狀態不是深淺。 */
.row.read {
  border-left: 3px solid var(--ring-read);
}
.row-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
}
.status {
  color: var(--edge-pending);
}
.more {
  width: 100%;
  margin-top: 10px;
}
.pane {
  overflow-y: auto;
  padding: 24px 32px 60px;
}
.pane article {
  max-width: 720px;
}
.position {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}
.doc-head h1 {
  font-size: 22px;
  margin: 4px 0 12px;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 14px;
  font-size: 12px;
  margin: 0 0 14px;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  color: var(--text-secondary);
  word-break: break-all;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.btn {
  display: inline-block;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--text);
  border-radius: var(--radius);
  padding: 6px 14px;
  text-decoration: none;
}
.note {
  font-size: 12px;
}
.notice {
  border-left: 3px solid var(--edge-pending);
  padding: 8px 12px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  border-radius: var(--radius);
}
.pages {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-subtle);
}
.para {
  margin: 0 0 14px;
  line-height: 1.85;
  white-space: pre-wrap;
}
.image-wrap img {
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.neighbours {
  display: flex;
  gap: 8px;
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--line-subtle);
}
.muted {
  color: var(--text-tertiary);
}
.empty,
.pick {
  font-size: 13px;
}
</style>

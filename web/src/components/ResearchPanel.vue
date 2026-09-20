<script setup lang="ts">
/**
 * 「研究」的規劃那一半（Stage 19，ADR-0033 D2／D5，REQ-0009 R1–R6）。
 *
 * ## 這個元件的每一塊都在回答「現在花了什麼」
 *
 * 舊的擴展按下去就開始搜尋、抓取、抽取，而使用者看不到模型打算怎麼找
 * （2026-09-18 的第 12 點）。所以這裡：
 *
 * - 開一次研究之前先說「只會查你已經有的資料，不花錢」
 * - 談一輪的按鈕旁邊說走哪個服務、會不會花錢、會不會上網查
 * - 閘門一旁邊說「按下去之前，一次搜尋、一次擷取都還沒有發生」
 *
 * ## 方向是可以直接改的（R4）
 *
 * 改動先留在本地（`draft`），按「存下改過的方向」才送出去 ——
 * 每打一個字就送一次的話，一次研究會在伺服器上留下幾十個版本，
 * 而使用者**看不出哪一版是他要的那一版**。
 */
import { computed, ref, watch } from 'vue';

import { api, type ApiError, type DirectionInput, type Research } from '../api';
import { fill, t } from '../i18n/zh-TW';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ (e: 'error', error: ApiError | null): void }>();

const list = ref<Research[]>([]);
const current = ref<Research | null>(null);
const topic = ref('');
const said = ref('');
const busy = ref<'' | 'start' | 'say' | 'save' | 'gate' | 'other'>('');
/** 方向的本地版本。**送出去之前不動伺服器上那一份。** */
const draft = ref<DirectionInput[]>([]);

const open = computed(() =>
  current.value !== null && current.value.status !== 'done' && current.value.status !== 'abandoned'
    ? current.value
    : null,
);
const planning = computed(() => open.value?.status === 'planning');
const service = computed(() => current.value?.service ?? null);
/** 模型名空著代表走 CLI 自己的預設 —— 那一格顯示服務的名字就夠了。 */
const serviceName = computed(() =>
  service.value === null ? '' : t.settings.connectionNames[service.value.via],
);
const modelName = computed(() =>
  service.value === null || service.value.model.length === 0
    ? serviceName.value
    : service.value.model,
);

function report(error: ApiError | null): void {
  emit('error', error);
}

function syncDraft(): void {
  draft.value = (current.value?.plan.directions ?? []).map((d) => ({
    title: d.title,
    what: d.what,
    expect: d.expect,
    keywords: [...d.keywords],
  }));
}

watch(current, syncDraft);

async function load(): Promise<void> {
  const res = await api.listResearch(props.slug);
  if (!res.ok) {
    report(res.error);
    return;
  }
  list.value = res.data;
  const live = res.data.find((r) => r.status !== 'done' && r.status !== 'abandoned') ?? null;
  current.value = live ?? current.value;
}

watch(() => props.slug, load, { immediate: true });

async function start(): Promise<void> {
  if (topic.value.trim().length === 0) return;
  busy.value = 'start';
  report(null);
  const res = await api.startResearch(props.slug, topic.value.trim());
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    return;
  }
  topic.value = '';
  current.value = res.data;
  await load();
}

async function talk(): Promise<void> {
  const id = open.value?.id;
  if (id === undefined) return;
  busy.value = 'say';
  report(null);
  const res = await api.converse(props.slug, id, said.value.trim());
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    // **失敗的一輪也留著**，所以這裡要重讀一次 —— 畫面上看得到它。
    const again = await api.getResearch(props.slug, id);
    if (again.ok) current.value = again.data;
    return;
  }
  said.value = '';
  current.value = res.data;
}

function addDirection(): void {
  draft.value = [...draft.value, { title: t.research.newDirection, what: '', expect: '' }];
}

function removeDirection(index: number): void {
  draft.value = draft.value.filter((_, i) => i !== index);
}

const dirty = computed(() => {
  const now = current.value?.plan.directions ?? [];
  if (now.length !== draft.value.length) return true;
  return draft.value.some((d, i) => {
    const before = now[i];
    return (
      before === undefined ||
      before.title !== (d.title ?? '') ||
      before.what !== (d.what ?? '') ||
      before.expect !== (d.expect ?? '')
    );
  });
});

async function saveDirections(): Promise<void> {
  const id = open.value?.id;
  if (id === undefined) return;
  busy.value = 'save';
  report(null);
  const res = await api.editDirections(
    props.slug,
    id,
    draft.value.filter((d) => (d.title ?? '').trim().length > 0),
  );
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    return;
  }
  current.value = res.data;
}

async function gateOne(): Promise<void> {
  const id = open.value?.id;
  if (id === undefined) return;
  busy.value = 'gate';
  report(null);
  const res = await api.startCollecting(props.slug, id);
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    return;
  }
  current.value = res.data;
  await load();
}

async function abandon(): Promise<void> {
  const id = open.value?.id;
  if (id === undefined) return;
  busy.value = 'other';
  report(null);
  const res = await api.abandonResearch(props.slug, id);
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    return;
  }
  current.value = res.data;
  await load();
}

async function remove(entry: Research): Promise<void> {
  busy.value = 'other';
  report(null);
  const res = await api.deleteResearch(props.slug, entry.id);
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    return;
  }
  if (current.value?.id === entry.id) current.value = null;
  await load();
}

function openEntry(entry: Research): void {
  current.value = entry;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('zh-TW', { hour12: false });
}

/** 花費：**沒回報的那幾輪單獨說** —— 合成一個數字對線上端點是一句謊。 */
const costText = computed(() => {
  const row = current.value;
  if (row === null) return '';
  const parts: string[] = [];
  if (row.costUsd > 0) parts.push(fill(t.research.costSoFar, { usd: row.costUsd.toFixed(2) }));
  if (row.unknownCost > 0) parts.push(fill(t.research.costUnknown, { n: row.unknownCost }));
  if (parts.length === 0) parts.push(t.research.costNone);
  return parts.join(' · ');
});

const hitsText = computed(() => {
  const row = current.value;
  if (row === null) return '';
  if (row.hitTotal === 0) return t.research.hitsEmptyCase;
  if (row.hits.length === 0) return fill(t.research.hitsNone, { total: row.hitTotal });
  return fill(t.research.hitsSome, { total: row.hitTotal, n: row.hits.length });
});
</script>

<template>
  <section class="card research">
    <h2>{{ t.research.title }}</h2>

    <!-- 還沒有進行中的研究：輸入主題。**這一步不花錢，而那句話在按鈕按下去之前就在。** -->
    <template v-if="open === null">
      <label class="field wide">
        <span>{{ t.research.topicLabel }}</span>
        <input v-model="topic" type="text" :placeholder="t.research.topicPlaceholder" />
      </label>
      <p class="hint">{{ t.research.freeHint }}</p>
      <div class="actions">
        <button class="primary" :disabled="busy !== '' || topic.trim().length === 0" @click="start">
          {{ busy === 'start' ? t.research.starting : t.research.start }}
        </button>
      </div>
    </template>

    <!-- 進行中的那一次。 -->
    <template v-else>
      <header class="live-head">
        <strong class="topic">{{ open.topic }}</strong>
        <span class="badge">{{ t.research.status[open.status] }}</span>
        <span class="muted small">{{ costText }}</span>
      </header>

      <p class="hits">{{ hitsText }}</p>
      <ul v-if="open.hits.length > 0" class="hit-list">
        <li v-for="hit in open.hits" :key="hit.itemId">
          <span class="hit-title">{{ hit.title }}</span>
          <span class="excerpt muted">{{ hit.excerpt }}</span>
        </li>
      </ul>

      <div v-if="planning" class="two">
        <!-- 左：對話。每一輪寫得出是誰說的、哪個模型、花了多少。 -->
        <div class="talk">
          <ul v-if="open.messages.length > 0" class="turns">
            <li v-for="m in open.messages" :key="m.id" :class="['turn', m.role]">
              <span class="who">{{ m.role === 'user' ? t.research.you : t.research.model }}</span>
              <span v-if="m.code !== null" class="failed">{{ t.research.failedTurn }}</span>
              <span v-else class="said">{{ m.content }}</span>
              <span v-if="m.role === 'model'" class="turn-meta muted">
                {{ m.model }}
                <template v-if="m.costUsd !== null && m.costUsd > 0">
                  · {{ fill(t.expand.cost, { usd: m.costUsd.toFixed(2) }) }}
                </template>
              </span>
            </li>
          </ul>

          <label class="field wide">
            <span>{{ t.research.sayLabel }}</span>
            <textarea v-model="said" rows="3" :placeholder="t.research.sayPlaceholder"></textarea>
          </label>
          <p class="hint">
            {{
              service?.costs
                ? fill(t.research.sayCosts, { service: serviceName, model: modelName })
                : fill(t.research.sayFree, { model: modelName })
            }}
          </p>
          <p v-if="service !== null && !service.browses" class="hint">{{ t.research.noBrowse }}</p>
          <div class="actions">
            <button :disabled="busy !== ''" @click="talk">
              {{ busy === 'say' ? t.research.saying : t.research.say }}
            </button>
          </div>
        </div>

        <!-- 右：目前的規劃。**可以直接改** —— 不必透過模型（R4）。 -->
        <div class="plan">
          <h3>{{ t.research.planTitle }}</h3>
          <p v-if="open.plan.relation.length > 0" class="relation">
            <span class="muted">{{ t.research.relation }}：</span>{{ open.plan.relation }}
          </p>
          <p v-if="open.plan.overflow" class="callout pending">
            {{ fill(t.research.overflow, { n: open.plan.directions.length }) }}
          </p>
          <p v-if="draft.length === 0" class="muted">{{ t.research.planEmpty }}</p>

          <ol v-else class="directions">
            <li v-for="(d, i) in draft" :key="i" class="direction">
              <div class="direction-head">
                <input v-model="d.title" type="text" class="title" />
                <span v-if="open.plan.directions[i]?.origin === 'human'" class="badge human">
                  {{ t.research.edited }}
                </span>
                <button class="quiet small" @click="removeDirection(i)">
                  {{ t.research.removeDirection }}
                </button>
              </div>
              <label class="field wide">
                <span>{{ t.research.directionWhat }}</span>
                <input v-model="d.what" type="text" />
              </label>
              <label class="field wide">
                <span>{{ t.research.directionExpect }}</span>
                <input v-model="d.expect" type="text" />
              </label>
              <p v-if="(d.keywords ?? []).length > 0" class="muted small">
                {{ t.research.directionKeywords }}：{{ (d.keywords ?? []).join('、') }}
              </p>
            </li>
          </ol>

          <p v-if="open.plan.outOfScope.length > 0" class="muted small">
            {{ t.research.outOfScope }}：{{ open.plan.outOfScope.join('、') }}
          </p>

          <div class="actions">
            <button class="small" :disabled="busy !== ''" @click="addDirection">
              {{ t.research.addDirection }}
            </button>
            <button class="small" :disabled="busy !== '' || !dirty" @click="saveDirections">
              {{ busy === 'save' ? t.research.savingDirections : t.research.saveDirections }}
            </button>
            <span class="hint">{{ t.research.directionsFree }}</span>
          </div>
        </div>
      </div>

      <!-- 閘門一之後：方向定案了。**照實說蒐集還沒做進這一版。** -->
      <div v-else class="frozen">
        <h3>{{ t.research.collectingTitle }}</h3>
        <p class="callout pending">
          {{
            fill(t.research.collectingBody, { n: open.directions.filter((d) => d.adopted).length })
          }}
        </p>
        <ol class="frozen-list">
          <li v-for="d in open.directions" :key="d.id" :class="{ dropped: !d.adopted }">
            {{ d.title }}
            <span v-if="!d.adopted" class="badge">{{ t.research.frozenNotAdopted }}</span>
            <span v-else-if="d.origin === 'human'" class="badge human">{{
              t.research.edited
            }}</span>
          </li>
        </ol>
      </div>

      <footer class="gate">
        <template v-if="planning">
          <p class="hint">{{ t.research.gateOneHint }}</p>
          <p v-if="draft.length > 0" class="hint">
            {{ fill(t.research.gateOneNext, { n: draft.length }) }}
          </p>
          <div class="actions">
            <button
              class="primary"
              :disabled="busy !== '' || draft.length === 0 || dirty"
              @click="gateOne"
            >
              {{ t.research.gateOne }}
            </button>
            <span v-if="draft.length === 0" class="hint">{{ t.research.gateOneNotReady }}</span>
            <button class="quiet" :disabled="busy !== ''" @click="abandon">
              {{ t.research.abandon }}
            </button>
          </div>
        </template>
        <div v-else class="actions">
          <button class="quiet" :disabled="busy !== ''" @click="abandon">
            {{ t.research.abandon }}
          </button>
        </div>
      </footer>
    </template>

    <!-- 歷次研究。**放棄與做完的都留著**，可以一筆一筆刪。 -->
    <div class="history">
      <h3>{{ t.research.listTitle }}</h3>
      <p v-if="list.length === 0" class="muted">{{ t.research.listEmpty }}</p>
      <ul v-else class="rows compact">
        <li v-for="entry in list" :key="entry.id">
          <button class="row link" @click="openEntry(entry)">{{ entry.topic }}</button>
          <span class="badge">{{ t.research.status[entry.status] }}</span>
          <span class="muted small">{{ when(entry.createdAt) }}</span>
          <button
            v-if="entry.status === 'done' || entry.status === 'abandoned'"
            class="quiet small"
            :disabled="busy !== ''"
            @click="remove(entry)"
          >
            {{ t.research.remove }}
          </button>
        </li>
      </ul>
      <p class="hint">{{ t.research.removeHint }}</p>
    </div>
  </section>
</template>

<style scoped>
.live-head {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  flex-wrap: wrap;
  margin-bottom: var(--s2);
}
.topic {
  font-size: var(--fs-section);
}
.hits {
  margin: 0 0 var(--s2);
  font-size: var(--fs-small);
}
.hit-list {
  list-style: none;
  margin: 0 0 var(--s3);
  padding: 0;
  display: grid;
  gap: var(--s1);
  font-size: var(--fs-small);
}
.hit-list > li {
  display: grid;
  gap: 2px;
}
.hit-list .hit-title {
  font-weight: 600;
}
/* 命中的那一段只給一行 —— 它是線索不是內容，要讀在閱讀器裡讀。 */
.hit-list .excerpt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 兩欄：對話在左、規劃在右。窄畫面疊起來。 */
.two {
  display: grid;
  gap: var(--s4);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
@media (max-width: 900px) {
  .two {
    grid-template-columns: minmax(0, 1fr);
  }
}
.turns {
  list-style: none;
  margin: 0 0 var(--s3);
  padding: 0;
  display: grid;
  gap: var(--s2);
  max-height: 320px;
  overflow-y: auto;
}
.turn {
  display: grid;
  gap: 2px;
  padding: var(--s2);
  border-radius: 6px;
  background: var(--bg-raised);
  font-size: var(--fs-small);
}
.turn.user {
  background: var(--bg-hover);
}
.who {
  color: var(--text-tertiary);
  font-size: var(--fs-label);
}
.said {
  white-space: pre-wrap;
}
.failed {
  color: var(--ui-danger);
}
.turn-meta {
  font-size: var(--fs-label);
}
.relation {
  margin: 0 0 var(--s2);
  font-size: var(--fs-small);
}
.directions,
.frozen-list {
  margin: 0 0 var(--s3);
  padding-left: var(--s4);
  display: grid;
  gap: var(--s3);
  font-size: var(--fs-small);
}
.direction-head {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.direction-head .title {
  flex: 1 1 12ch;
  min-width: 0;
}
.direction .field {
  margin-top: var(--s1);
}
.badge.human {
  color: var(--ui-action);
}
.frozen-list .dropped {
  color: var(--text-tertiary);
  text-decoration: line-through;
}
.gate {
  margin-top: var(--s3);
  padding-top: var(--s3);
  border-top: 1px solid var(--line-subtle);
}
.history {
  margin-top: var(--s4);
  padding-top: var(--s3);
  border-top: 1px solid var(--line-subtle);
}
.rows {
  list-style: none;
  margin: 0 0 var(--s2);
  padding: 0;
  display: grid;
  gap: var(--s1);
  font-size: var(--fs-small);
}
.rows > li {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex-wrap: wrap;
}
.rows .row {
  text-align: left;
}
</style>

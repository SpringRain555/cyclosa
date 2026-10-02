<script setup lang="ts">
/**
 * 抽進圖（整理的第一片，v0.26.0，ADR-0033 S24）。
 *
 * 匯入不抽關聯、研究建圖只抽它找來的那幾份 —— 專題裡其餘「還沒抽過」的資料在這裡列給你勾。
 * **預設不勾**（Q10）：抽要時間、線上的模型要花額度，而且抽出來的每一條都要你裁決。
 * 清單是事實（資料庫數得出來），不是模型的意見，所以打開這一塊不呼叫任何模型。
 */
import { computed, ref, watch } from 'vue';

import { api, type ApiError, type ConsolidateView, type ServiceView } from '../api';
import { fill, t } from '../i18n/zh-TW';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ error: [ApiError]; started: [string] }>();

/** 抽取只讀正文開頭這麼多字（`MAX_TEXT_CHARS`）。比這長的那幾份要標出來。 */
const READ_CHARS = 12_000;

const view = ref<ConsolidateView | null>(null);
const picked = ref<ReadonlySet<string>>(new Set());
const busy = ref(false);

async function load(): Promise<void> {
  const result = await api.consolidate(props.slug);
  if (!result.ok) {
    emit('error', result.error);
    return;
  }
  view.value = result.data;
  // 清單變了（剛抽完、剛排除）：不在清單上的勾拿掉，不然按下去會整批被退回。
  const listed = new Set(result.data.items.map((item) => item.id));
  picked.value = new Set([...picked.value].filter((id) => listed.has(id)));
}

watch(
  () => props.slug,
  () => {
    picked.value = new Set();
    void load();
  },
  { immediate: true },
);
defineExpose({ reload: load });

/** 研究沒結束、或已經有一筆在跑：清單照樣看得到，只是不能勾、不能按（D4）。 */
const blocked = computed(
  () => view.value === null || view.value.runId !== null || view.value.researchOpen,
);

function toggle(id: string, on: boolean): void {
  const next = new Set(picked.value);
  if (on) next.add(id);
  else next.delete(id);
  picked.value = next;
}

function selectAll(on: boolean): void {
  picked.value = on ? new Set((view.value?.items ?? []).map((item) => item.id)) : new Set();
}

function serviceText(s: ServiceView): string {
  const name = t.settings.connectionNames[s.via];
  const label = s.model.length === 0 ? name : `${name} · ${s.model}`;
  return fill(s.costs ? t.research.serviceCosts : t.research.serviceFree, { service: label });
}

function openRunning(): void {
  const id = view.value?.runId;
  if (id !== null && id !== undefined) emit('started', id);
}

function kindText(kind: string): string {
  return (t.search.kinds as Record<string, string>)[kind] ?? kind;
}

async function start(): Promise<void> {
  if (picked.value.size === 0 || blocked.value) return;
  busy.value = true;
  const result = await api.startConsolidate(props.slug, [...picked.value]);
  busy.value = false;
  if (!result.ok) {
    emit('error', result.error);
    await load();
    return;
  }
  picked.value = new Set();
  await load();
  emit('started', result.data.runId);
}
</script>

<template>
  <section class="card consolidate">
    <h2>{{ t.consolidate.title }}</h2>
    <p class="card-what">{{ t.consolidate.what }}</p>

    <template v-if="view">
      <p class="hint">{{ t.consolidate.head }}</p>
      <p class="hint">
        {{ fill(t.consolidate.service, { service: serviceText(view.extractService) }) }}
      </p>
      <p v-if="view.researchOpen" class="hint blocked">{{ t.consolidate.researchOpen }}</p>
      <p v-else-if="view.runId !== null" class="hint blocked">
        {{ t.consolidate.running }}
        <button class="link" type="button" @click="openRunning">
          {{ t.consolidate.runningLink }}
        </button>
      </p>

      <p v-if="view.items.length === 0" class="muted empty">{{ t.consolidate.empty }}</p>
      <template v-else>
        <div class="pick-head">
          <span>{{ fill(t.consolidate.count, { n: view.items.length }) }}</span>
          <button class="small" type="button" :disabled="blocked" @click="selectAll(true)">
            {{ t.consolidate.selectAll }}
          </button>
          <button
            class="small"
            type="button"
            :disabled="blocked || picked.size === 0"
            @click="selectAll(false)"
          >
            {{ t.consolidate.selectNone }}
          </button>
        </div>
        <ul class="pick-list">
          <li v-for="item in view.items" :key="item.id">
            <label class="check">
              <input
                type="checkbox"
                :checked="picked.has(item.id)"
                :disabled="blocked"
                @change="toggle(item.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="pick-title">{{ item.title }}</span>
            </label>
            <span class="pick-meta muted">
              {{ kindText(item.kind) }} ·
              {{ fill(t.consolidate.chars, { n: item.chars.toLocaleString('zh-TW') }) }}
              <template v-if="item.chars > READ_CHARS"> · {{ t.consolidate.partial }}</template>
            </span>
          </li>
        </ul>
        <div class="actions">
          <button
            class="primary"
            type="button"
            :disabled="busy || blocked || picked.size === 0"
            @click="start"
          >
            {{ busy ? t.consolidate.starting : fill(t.consolidate.start, { n: picked.size }) }}
          </button>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.consolidate .hint + .hint {
  margin-top: var(--s1);
}
.blocked {
  margin-top: var(--s2);
}
.empty {
  margin: var(--s3) 0 0;
}
.pick-head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex-wrap: wrap;
  margin: var(--s3) 0 var(--s2);
  font-size: var(--fs-small);
}
/* 一本書二十幾章：清單自己捲，不把整頁撐長。 */
.pick-list {
  list-style: none;
  margin: 0 0 var(--s3);
  padding: var(--s1) 0;
  max-height: 320px;
  overflow-y: auto;
  border-top: 1px solid var(--line-subtle);
  border-bottom: 1px solid var(--line-subtle);
}
.pick-list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s3);
  padding: var(--s1) 0;
}
.pick-title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.pick-meta {
  flex: none;
  font-size: var(--fs-label);
  white-space: nowrap;
}
@media (max-width: 720px) {
  .pick-list li {
    flex-direction: column;
    gap: 2px;
  }
  .pick-meta {
    padding-left: var(--s5);
  }
}
</style>

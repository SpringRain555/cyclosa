<script setup lang="ts">
/**
 * 右側欄：選取的東西。
 *
 * **精確操作全部在這裡，不在 3D 裡**（ADR-0007）——
 * 研究說比較與分析這類任務在 3D 裡更慢，所以 3D 只做瀏覽與結構感。
 *
 * 可信度那一段照 ADR-0017 的三件事一起出現：
 * **等級（不給小數）＋ 構成事實攤開 ＋ 校準比例**。
 *
 * ## 裁決的入口在這裡，但裁決本身在 `EdgePanel`
 *
 * 在 3D 空間裡點中一條線，比點中一個節點難得多 ——
 * 而裁決是這個工具最不該點錯的動作。所以流程是
 * **先選一個節點，再從它的關聯清單裡挑一條**（ADR-0007：精確操作在右側欄）。
 */
import { computed, ref, watch } from 'vue';

import type { ApiError, EdgeLayer, Item, SubgraphEdge, SubgraphNode } from '../../api';
import { fill, guideItem, t } from '../../i18n/zh-TW';
import { useTranslationStore } from '../../stores/translation-store';
import TranslationSwitch from '../TranslationSwitch.vue';
import TranslationNotice from '../TranslationNotice.vue';
import ErrorPanel from '../ErrorPanel.vue';

const props = defineProps<{
  slug: string;
  node: SubgraphNode | null;
  edges: SubgraphEdge[];
  nodes: SubgraphNode[];
  /** 正在拉一條線的起點。**不是 null 就代表下一次點節點是在選終點** */
  connectFrom: string | null;
}>();

const emit = defineEmits<{
  (event: 'focus', id: string): void;
  (event: 'open-reader', id: string): void;
  (event: 'open-edge', id: string): void;
  (event: 'start-connect', id: string): void;
  (event: 'cancel-connect'): void;
  (event: 'create-edge', payload: { target: string; rel: string; layer: EdgeLayer }): void;
}>();

const rel = ref('');
const layer = ref<EdgeLayer>('named');
const translation = useTranslationStore();
const translatedItem = ref<Item | null>(null);
const translationError = ref<ApiError | null>(null);
const hasTranslation = computed(() => {
  if (props.node?.kind !== 'item') return false;
  if (translatedItem.value !== null)
    return Boolean(translatedItem.value.titleZh || translatedItem.value.summaryZh);
  return Boolean(props.node.titleZh || props.node.digestedAt !== null);
});
const showTranslation = computed(() => translation.translated && hasTranslation.value);

watch(
  [() => props.slug, () => props.node, () => translation.translated],
  async ([slug, selected, translated], _previous, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    translatedItem.value = null;
    translationError.value = null;
    if (
      !translated ||
      selected?.kind !== 'item' ||
      !(selected.titleZh || selected.digestedAt !== null)
    )
      return;
    const result = await translation.item(slug, selected.id, selected.digestedAt);
    if (!active) return;
    if (result.ok) translatedItem.value = result.data.item;
    else translationError.value = result.error;
  },
  { immediate: true },
);

/** 換了一個終點就把輸入清掉 —— 留著上一次打的字只會被誤送出去。 */
watch(
  () => props.node?.id,
  () => {
    rel.value = '';
  },
);

/**
 * 現在正在挑終點：有起點，而且選取的節點**不是**起點本身。
 * 選回起點時不顯示表單 —— 那是「我看一下起點是誰」，不是「終點就是它」。
 */
const pickingTarget = computed(
  () => props.connectFrom !== null && props.node !== null && props.node.id !== props.connectFrom,
);

const connectFromTitle = computed(() =>
  props.connectFrom === null ? '' : titleOf(props.connectFrom),
);

/** 具名關係一定要有名字。**沒有名字的關係日後也篩不出來。** */
const canCreate = computed(() => layer.value !== 'named' || rel.value.trim().length > 0);

function submit(): void {
  const target = props.node?.id;
  if (target === undefined || !canCreate.value) return;
  emit('create-edge', { target, rel: rel.value.trim(), layer: layer.value });
}

const kindLabel = computed(() => {
  const node = props.node;
  if (node === null) return '';
  if (node.kind === 'entity') {
    return t.graph.entityType[node.subKind as keyof typeof t.graph.entityType] ?? node.subKind;
  }
  return t.graph.itemKind[node.subKind as keyof typeof t.graph.itemKind] ?? node.subKind;
});

function titleOf(id: string): string {
  return props.nodes.find((n) => n.id === id)?.title ?? id;
}

function relLabel(edge: SubgraphEdge): string {
  const layer = t.graph.layer[edge.layer];
  return edge.rel.length > 0 && edge.layer === 'named' ? `${edge.rel}（${layer}）` : layer;
}
</script>

<template>
  <aside class="selection">
    <h2>{{ t.graph.selection.title }}</h2>

    <p v-if="node === null" class="hint">{{ t.graph.selection.none }}</p>

    <template v-else>
      <!-- 沒有譯文就不放切換：面板上每一份手動匯入的都多一行「還沒有譯文」只是雜訊。 -->
      <div v-if="node.kind === 'item' && hasTranslation" class="translation-switch">
        <TranslationSwitch :available="hasTranslation" />
      </div>
      <h3 class="title">
        {{ showTranslation ? translatedItem?.titleZh || node.titleZh || node.title : node.title }}
      </h3>
      <p v-if="showTranslation && (translatedItem?.titleZh || node.titleZh)" class="original-title">
        {{ node.title }}
      </p>
      <ErrorPanel v-if="translationError" :error="translationError" />
      <section v-if="showTranslation">
        <p v-if="translatedItem?.summaryZh" class="excerpt">{{ translatedItem.summaryZh }}</p>
        <TranslationNotice :model="node.digestedBy" :date="node.digestedAt" />
      </section>

      <dl class="facts">
        <dt>{{ t.graph.selection.kind }}</dt>
        <dd>{{ kindLabel }}</dd>

        <template v-if="node.kind === 'entity' && node.mentionCount !== null">
          <dt>{{ guideItem('nodeEntity').short }}</dt>
          <dd>{{ fill(t.graph.selection.mentions, { n: node.mentionCount }) }}</dd>
        </template>

        <template v-if="node.kind === 'item'">
          <dt>{{ t.graph.selection.read }}</dt>
          <dd>{{ node.readAt === null ? t.graph.selection.unread : t.graph.selection.read }}</dd>
        </template>

        <template v-if="node.lang !== null">
          <dt>{{ t.graph.selection.language }}</dt>
          <dd>{{ node.lang === 'und' ? t.reader.unknownLanguage : node.lang }}</dd>
        </template>

        <template v-if="node.derivedFolded > 0">
          <dt>{{ t.graph.layer.derived }}</dt>
          <dd>{{ fill(t.graph.selection.folded, { n: node.derivedFolded }) }}</dd>
        </template>
      </dl>

      <p v-if="!showTranslation && node.excerpt.length > 0" class="excerpt">{{ node.excerpt }}</p>

      <div class="actions">
        <button type="button" @click="emit('focus', node.id)">
          {{ t.graph.toolbar.focusOn }}
        </button>
        <button v-if="node.kind === 'item'" type="button" @click="emit('open-reader', node.id)">
          {{ t.graph.toolbar.openInReader }}
        </button>
      </div>

      <!-- ── 手動連一條線 ────────────────────────────────── -->
      <div v-if="pickingTarget" class="connect">
        <p class="pair">
          <span class="muted">{{ t.graph.connect.from }}</span> {{ connectFromTitle }}
          <br />
          <span class="muted">{{ t.graph.connect.to }}</span> {{ node.title }}
        </p>

        <label class="field">
          <span class="muted">{{ t.graph.connect.layer }}</span>
          <select v-model="layer">
            <option value="named">{{ t.graph.connect.layerNamed }}</option>
            <option value="derived">{{ t.graph.connect.layerDerived }}</option>
          </select>
        </label>

        <label v-if="layer === 'named'" class="field">
          <span class="muted">{{ t.graph.connect.rel }}</span>
          <input
            v-model="rel"
            type="text"
            :placeholder="t.graph.connect.relPlaceholder"
            @keyup.enter="submit()"
          />
        </label>

        <div class="actions">
          <button type="button" :disabled="!canCreate" @click="submit()">
            {{ t.graph.connect.create }}
          </button>
          <button type="button" @click="emit('cancel-connect')">
            {{ t.graph.connect.cancel }}
          </button>
        </div>
        <p class="hint">{{ t.graph.connect.createdNotice }}</p>
      </div>

      <div v-else-if="connectFrom !== null" class="connect">
        <!-- **進行中的模式一定要說出來**，否則下一次點擊會做出使用者沒預期的事 -->
        <p class="hint">{{ t.graph.connect.picking }}</p>
        <button type="button" @click="emit('cancel-connect')">
          {{ t.graph.connect.cancel }}
        </button>
      </div>

      <button v-else type="button" class="wide" @click="emit('start-connect', node.id)">
        {{ t.graph.connect.start }}
      </button>

      <h3 class="section">{{ fill(t.graph.selection.edgesHere, { n: edges.length }) }}</h3>

      <ul class="edges">
        <li v-for="edge in edges" :key="edge.id">
          <p class="rel">
            {{ relLabel(edge) }}
            <span v-if="edge.layer === 'named'" class="badge">
              {{ t.graph.edgeStatus[edge.status] }}
            </span>
            <span v-if="edge.previouslyRejected" class="badge warn">
              {{ t.graph.selection.previouslyRejected }}
            </span>
          </p>
          <p class="between">{{ titleOf(edge.source) }} → {{ titleOf(edge.target) }}</p>

          <!-- **可信度只在具名關係上有意義** —— 另外三層是計算結果，
               把一個「弱／中／強」貼在相似度分數上只會讓那三個字失去意思 -->
          <template v-if="edge.layer === 'named'">
            <p class="tier">
              {{ t.graph.selection.tier }}：<strong>{{ t.graph.tier[edge.tier] }}</strong>
            </p>
            <p class="facts-line">
              {{ fill(t.graph.selection.evidence, { n: edge.evidenceCount }) }} ·
              {{ fill(t.graph.selection.independent, { n: edge.independentSourceCount }) }} ·
              {{ edge.hasDirectQuote ? t.graph.selection.hasQuote : t.graph.selection.noQuote }}
            </p>
            <p v-if="edge.evidenceCount > edge.independentSourceCount" class="hint">
              {{ t.graph.selection.independentWarning }}
            </p>
            <p class="hint">{{ t.graph.selection.calibrationInsufficient }}</p>
          </template>

          <p v-if="edge.synthetic" class="hint">{{ t.graph.selection.synthetic }}</p>
          <!-- **投影出來的線沒有東西可以打開** —— 它不是資料庫裡的一列 -->
          <button v-else type="button" class="link" @click="emit('open-edge', edge.id)">
            {{ t.graph.selection.openEdge }}
          </button>
        </li>
      </ul>
    </template>
  </aside>
</template>

<style scoped>
.selection {
  width: 296px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px 14px 20px;
  background: var(--bg-panel);
  border-left: 1px solid var(--line-subtle);
  font-size: var(--fs-label);
}
/* 面板的小標是灰色的標籤字，不是頁面的 h2。 */
.selection h2 {
  font-size: var(--fs-label);
  color: var(--text-tertiary);
  margin: 0 0 10px;
}
.title {
  font-size: var(--fs-body);
  margin: 0 0 10px;
  line-height: 1.4;
  color: var(--text);
}
.translation-switch {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  margin-bottom: 10px;
}
.original-title {
  font-size: var(--fs-small);
  color: var(--text-muted);
}
.section {
  font-size: var(--fs-label);
  color: var(--text-muted);
  margin: 18px 0 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line-subtle);
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  margin: 0 0 10px;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  color: var(--text-secondary);
}
.excerpt {
  margin: 0 0 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
.actions {
  display: flex;
  gap: 6px;
}
.actions button {
  flex: 1;
  font-size: var(--fs-label);
  padding: 5px 0;
}
.edges {
  list-style: none;
  margin: 0;
  padding: 0;
}
.edges li {
  padding: 8px 0;
  border-bottom: 1px solid var(--line-subtle);
}
.rel {
  margin: 0 0 3px;
  color: var(--text);
}
.between {
  margin: 0 0 4px;
  color: var(--text-tertiary);
  line-height: 1.5;
}
.tier {
  margin: 0 0 2px;
  color: var(--text-secondary);
}
.facts-line {
  margin: 0 0 3px;
  color: var(--text-tertiary);
}
.badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-raised);
  color: var(--text-tertiary);
  font-size: var(--fs-label);
}
.badge.warn {
  color: var(--edge-pending);
}
.hint {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.5;
}
.link {
  padding: 0;
  margin-top: 2px;
  border: 0;
  background: none;
  color: var(--ui-action);
  font: inherit;
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.wide {
  width: 100%;
  margin-top: 8px;
  padding: 5px 0;
  font-size: var(--fs-label);
}
.connect {
  margin-top: 10px;
  padding: 10px;
  background: var(--bg-raised);
  border-radius: 4px;
}
.connect .actions {
  margin-top: 8px;
}
.connect .actions button {
  font-size: var(--fs-label);
  padding: 4px 0;
}
.connect .actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pair {
  margin: 0 0 8px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.muted {
  color: var(--text-muted);
}
.field {
  display: block;
  margin-bottom: 6px;
}
.field span {
  display: block;
  margin-bottom: 2px;
}
.field input,
.field select {
  width: 100%;
  box-sizing: border-box;
  font-size: var(--fs-label);
}
.connect .hint {
  margin-top: 6px;
}
</style>

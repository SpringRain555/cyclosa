<script setup lang="ts">
/**
 * 右側欄：選取的東西。
 *
 * **精確操作全部在這裡，不在 3D 裡**（ADR-0007）——
 * 研究說比較與分析這類任務在 3D 裡更慢，所以 3D 只做瀏覽與結構感。
 *
 * 可信度那一段照 ADR-0017 的三件事一起出現：
 * **等級（不給小數）＋ 構成事實攤開 ＋ 校準比例**。
 * 校準比例要 30 條以上的樣本才顯示 —— 這一版還沒有裁決紀錄，
 * 所以它固定顯示「樣本不足」，**而那句話是誠實的**。
 */
import { computed } from 'vue';

import type { SubgraphEdge, SubgraphNode } from '../../api';
import { fill, t } from '../../i18n/zh-TW';

const props = defineProps<{
  node: SubgraphNode | null;
  edges: SubgraphEdge[];
  nodes: SubgraphNode[];
}>();

const emit = defineEmits<{
  (event: 'focus', id: string): void;
  (event: 'open-reader', id: string): void;
}>();

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
      <h3 class="title">{{ node.title }}</h3>

      <dl class="facts">
        <dt>{{ t.graph.selection.kind }}</dt>
        <dd>{{ kindLabel }}</dd>

        <template v-if="node.kind === 'entity' && node.mentionCount !== null">
          <dt>{{ t.graph.legend.nodeEntity }}</dt>
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

      <p v-if="node.excerpt.length > 0" class="excerpt">{{ node.excerpt }}</p>

      <div class="actions">
        <button type="button" @click="emit('focus', node.id)">
          {{ t.graph.toolbar.focusOn }}
        </button>
        <button v-if="node.kind === 'item'" type="button" @click="emit('open-reader', node.id)">
          {{ t.graph.toolbar.openInReader }}
        </button>
      </div>

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
        </li>
      </ul>

      <p class="hint later">{{ t.graph.selection.adjudicationLater }}</p>
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
  font-size: 12px;
}
h2 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 10px;
}
.title {
  font-size: 14px;
  margin: 0 0 10px;
  line-height: 1.4;
  color: var(--text);
}
.section {
  font-size: 11px;
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
  font-size: 12px;
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
  font-size: 11px;
}
.badge.warn {
  color: var(--edge-pending);
}
.hint {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.5;
}
.later {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--line-subtle);
}
</style>

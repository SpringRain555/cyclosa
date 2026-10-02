<script setup lang="ts">
/**
 * 右側欄：**選取的那一條關聯**。
 *
 * ui-workflows 的「選取一條關聯時」那一節就是這一份的規格。
 *
 * ## 為什麼關聯不是在 3D 裡點的
 *
 * ADR-0007：**精確操作全部在右側欄，不在 3D 裡。**
 * 在 3D 空間裡要點中一條線，比點中一個節點難得多 ——
 * 而裁決是這個工具最不該點錯的動作。
 * 所以入口是**節點面板上的關聯清單**：先選一個節點，再從它的關聯裡挑一條。
 *
 * ## 三件事一起出現，缺一件就退回原來的問題（ADR-0017）
 *
 * 等級（不給小數）＋ 構成事實攤開 ＋ 校準比例。
 */
import { computed } from 'vue';

import type { EdgeAction, EdgeDetail } from '../../api';
import { fill, t } from '../../i18n/zh-TW';

/**
 * **錯誤不在這裡顯示。**
 *
 * 裁決失敗與建立關聯失敗要出現在同一個地方，而後者發生時
 * 顯示中的是 `SelectionPanel` 不是這一份 —— 各自顯示的話，
 * 建立失敗的訊息會落在一個當下沒有掛載的元件裡，**於是完全看不見**。
 * 所以它在 `CaseGraphView` 的工具列底下，一條，兩種情況都看得到。
 */
const props = defineProps<{
  detail: EdgeDetail | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  (event: 'act', action: EdgeAction): void;
  (event: 'focus', id: string): void;
  (event: 'close'): void;
}>();

const layerLabel = computed(() => (props.detail === null ? '' : t.graph.layer[props.detail.layer]));

/**
 * **出處筆數不等於獨立來源數。**
 * 兩個數字相同的時候不必特別說 —— 只有不同的時候那句話才帶資訊。
 */
const reprintWarning = computed(
  () => props.detail !== null && props.detail.evidenceCount > props.detail.independentSourceCount,
);

const calibrationLine = computed(() => {
  const c = props.detail?.calibration;
  if (c === undefined || c.kind !== 'ok') return null;
  return fill(t.graph.adjudication.calibration, {
    confirmed: Math.round(c.confirmedRate * 100),
    rejected: Math.round(c.rejectedRate * 100),
    n: c.sampleSize,
  });
});

function actionLabel(action: EdgeAction): string {
  return t.graph.adjudication[action];
}

function actionHint(action: EdgeAction): string {
  return t.graph.adjudication.hint[action];
}

/**
 * 「確認」在沒有出處時按不下去。
 *
 * **先說再按** —— 一個按下去才告訴你不行的按鈕，
 * 使用者第二次就不會相信其他按鈕了。
 */
function isDisabled(action: EdgeAction): boolean {
  if (props.detail === null) return true;
  const lands =
    action === 'confirm' || (action === 'reclassify' && props.detail.status === 'rejected');
  return lands && props.detail.confirmNeedsEvidence;
}

function actorLabel(actor: 'human' | 'machine'): string {
  return actor === 'human' ? t.graph.adjudication.byHuman : t.graph.adjudication.byMachine;
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString('zh-Hant');
}
</script>

<template>
  <aside class="edge-panel">
    <div class="head">
      <h2>{{ t.graph.adjudication.title }}</h2>
      <button type="button" class="link" @click="emit('close')">
        {{ t.graph.adjudication.back }}
      </button>
    </div>

    <p v-if="loading" class="hint">{{ t.graph.adjudication.loading }}</p>

    <template v-else-if="detail !== null">
      <h3 class="title">
        {{ detail.rel.length > 0 ? detail.rel : layerLabel }}
        <!--
          **狀態只在裁決得動的邊上顯示。**

          第一版無條件顯示，於是一條共同提及線的標題旁邊寫著「待查證」，
          而正下方那一句寫著「沒有確認與否決」—— **同一屏上兩句話互相矛盾**。
          那個欄位在那些列上永遠是 `pending`（migration 003 逼的），
          它不帶資訊，顯示它只會誤導：沒有人在等你查證那條線。

          這就是 open-questions Q6「那個值沒有意義」在顯示層的另一半 ——
          v0.3.0 處理過圖上的線，而這個面板是 v0.4.0 才有的新地方。
        -->
        <span v-if="detail.fields.status" class="badge">
          {{ t.graph.edgeStatus[detail.status] }}
        </span>
        <span v-if="detail.previouslyRejected" class="badge warn">
          {{ t.graph.selection.previouslyRejected }}
        </span>
      </h3>

      <p class="between">
        <button type="button" class="link" @click="emit('focus', detail.source)">
          {{ detail.sourceTitle }}
        </button>
        <span class="arrow">→</span>
        <button type="button" class="link" @click="emit('focus', detail.target)">
          {{ detail.targetTitle }}
        </button>
      </p>

      <dl class="facts">
        <dt>{{ t.graph.selection.kind }}</dt>
        <dd>{{ layerLabel }}</dd>

        <dt>{{ t.graph.adjudication.origin }}</dt>
        <dd>
          {{
            detail.origin === 'human'
              ? t.graph.adjudication.originHuman
              : t.graph.adjudication.originMachine
          }}
        </dd>

        <!--
          **可信度只對「機器抽出來的具名關係」有意義。**

          另外三層是計算結果（ADR-0017 那三個字對它們不成立），
          而**人手動建的邊根本沒有可信度可言** —— 那個欄位存的 1
          是為了讓線畫得夠粗，不是量出來的。第一版照樣顯示，
          於是自己剛連的一條線旁邊寫著「可信度：強」，
          讀起來像有什麼東西評估過它。**沒有，那就是你說的。**
        -->
        <template v-if="detail.origin !== 'human' && detail.fields.tier">
          <dt>{{ t.graph.selection.tier }}</dt>
          <dd>{{ t.graph.tier[detail.tier] }}</dd>
        </template>

        <dt>{{ t.graph.adjudication.createdAt }}</dt>
        <dd>{{ when(detail.createdAt) }}</dd>
      </dl>

      <!--
        ── 這一整塊只在裁決得動的邊上出現 ──────────────────

        構成事實、按鈕、出處、裁決歷史 —— **四樣的存在理由都是
        「支撐或記錄一個判斷」**（ADR-0017、ADR-0016）。
        一條算出來的線沒有判斷可做，那四樣就全部是雜訊：
        「出處 0 筆」讀起來像這條線缺了什麼，而它其實什麼都不缺；
        「還沒有人裁決過這一條」聽起來像在等人，而永遠不會有人。

        所以不裁決的邊只顯示**它是什麼**，然後一句話說明為什麼沒有按鈕。
      -->
      <template v-if="detail.fields.adjudication">
        <!--
          **構成事實與校準比例也只對機器抽出來的邊成立。**
          它們回答的是「機器提的這一條憑什麼，而我判這類判得準不準」。
          對一條你自己連的邊，「出處 0 筆 · 沒有直接引文」讀起來像它很弱 ——
          而在這個工具的模型裡，人親手連的線是最強的那一種。
        -->
        <p v-if="detail.origin === 'human'" class="hint">{{ t.graph.selection.humanRelation }}</p>
        <template v-else-if="detail.fields.evidenceFacts">
          <p class="facts-line">
            {{ fill(t.graph.selection.evidence, { n: detail.evidenceCount }) }} ·
            {{ fill(t.graph.selection.independent, { n: detail.independentSourceCount }) }} ·
            {{ detail.hasDirectQuote ? t.graph.selection.hasQuote : t.graph.selection.noQuote }}
          </p>
          <p v-if="reprintWarning" class="hint">{{ t.graph.selection.independentWarning }}</p>
          <p class="hint">{{ calibrationLine ?? t.graph.selection.calibrationInsufficient }}</p>
        </template>

        <!-- ── 裁決 ──────────────────────────────────────── -->
        <div class="actions">
          <!--
            **這些按鈕一個都沒有顏色，而那是刻意的。**

            第一版把「否決」做成紅色，而 ADR-0018 明寫相反：
            「`#f85149` 在關聯圖上永不出現：**紅色留給真的壞掉的東西，
            而『已否決』不是壞掉**」。否決是可以復原的一個判斷，
            把它畫成危險動作會讓人不敢按 —— 而不敢按的裁決就是沒有裁決。

            那也不能反過來把「確認」染成主色：**這是一個判斷介面，
            不是一個表單。** 給其中一個選項視覺優勢，就是在推使用者往那邊倒，
            而校準比例正好會把那個偏差記下來變成「你確認了 92%」。
            兩個都素色，靠**文字**分辨 —— 那也正是 ADR-0018 那條
            「一律配圖示或文字，永遠不會只靠顏色說話」。
          -->
          <button
            v-for="action in detail.actions"
            :key="action"
            type="button"
            :disabled="isDisabled(action)"
            :title="actionHint(action)"
            @click="emit('act', action)"
          >
            {{ actionLabel(action) }}
          </button>
        </div>
        <p v-if="detail.confirmNeedsEvidence" class="hint">
          {{ t.graph.adjudication.needsEvidence }}
        </p>
        <p v-if="detail.status === 'rejected'" class="hint">
          {{ t.graph.adjudication.rejectedNotice }}
        </p>

        <!-- ── 出處與引文 ────────────────────────────────── -->
        <h3 class="section">{{ t.graph.adjudication.evidence }}</h3>
        <ul v-if="detail.evidence.length > 0" class="evidence">
          <li v-for="e in detail.evidence" :key="e.id">
            <blockquote>{{ e.quote }}</blockquote>
            <p class="source">
              {{ t.graph.adjudication.fromItem }}
              <button type="button" class="link" @click="emit('focus', e.itemId)">
                {{ e.itemTitle }}
              </button>
              <span class="mono range">
                {{ fill(t.graph.adjudication.charRange, { start: e.charStart, end: e.charEnd }) }}
              </span>
            </p>
          </li>
        </ul>
        <p v-else class="hint">
          {{
            detail.origin === 'human'
              ? t.graph.adjudication.humanNoEvidence
              : t.graph.adjudication.noEvidence
          }}
        </p>

        <!-- ── 裁決歷史 ──────────────────────────────────── -->
        <h3 class="section">{{ t.graph.adjudication.history }}</h3>
        <ol v-if="detail.audit.length > 0" class="history">
          <li v-for="(entry, i) in detail.audit" :key="i">
            <span class="mono when">{{ when(entry.at) }}</span>
            <span>
              {{ actorLabel(entry.actor) }} ·
              {{
                entry.actor === 'machine'
                  ? t.graph.adjudication.revived
                  : (t.graph.adjudication.action[
                      entry.action as keyof typeof t.graph.adjudication.action
                    ] ?? entry.action)
              }}
            </span>
            <span class="hint">
              {{ t.graph.edgeStatus[entry.fromStatus as 'pending'] }} →
              {{ t.graph.edgeStatus[entry.toStatus as 'pending'] }}
            </span>
          </li>
        </ol>
        <p v-else class="hint">{{ t.graph.adjudication.noHistory }}</p>
      </template>

      <!-- 不裁決的邊到此為止：**它是什麼**，加一句為什麼沒有按鈕。 -->
      <p v-else class="hint boxed">{{ t.graph.adjudication.notAdjudicable }}</p>
    </template>
  </aside>
</template>

<style scoped>
.edge-panel {
  width: 296px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px 14px 20px;
  background: var(--bg-panel);
  border-left: 1px solid var(--line-subtle);
  font-size: var(--fs-label);
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}
/* 面板的小標是灰色的標籤字，不是頁面的 h2。 */
.edge-panel h2 {
  font-size: var(--fs-label);
  color: var(--text-tertiary);
}
.title {
  font-size: var(--fs-body);
  margin: 0 0 8px;
  line-height: 1.5;
  color: var(--text);
}
.between {
  margin: 0 0 10px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
.arrow {
  margin: 0 4px;
  color: var(--text-muted);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-action);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.link:hover {
  text-decoration: underline;
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
.facts-line {
  margin: 0 0 3px;
  color: var(--text-tertiary);
}
.section {
  font-size: var(--fs-label);
  color: var(--text-muted);
  margin: 18px 0 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line-subtle);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 6px;
}
.actions button {
  flex: 1 1 auto;
  padding: 5px 10px;
  font-size: var(--fs-label);
}
.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.evidence {
  list-style: none;
  margin: 0;
  padding: 0;
}
.evidence li {
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--line-subtle);
}
blockquote {
  margin: 0 0 4px;
  padding-left: 8px;
  border-left: 2px solid var(--line-subtle);
  color: var(--text-secondary);
  line-height: 1.6;
}
.source {
  margin: 0;
  color: var(--text-tertiary);
}
.range {
  margin-left: 6px;
  color: var(--text-muted);
}
.history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history li {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 0;
  border-bottom: 1px solid var(--line-subtle);
  color: var(--text-secondary);
}
.when {
  color: var(--text-muted);
}
.badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-raised);
  color: var(--text-tertiary);
  font-size: var(--fs-label);
  vertical-align: middle;
}
.badge.warn {
  color: var(--edge-pending);
}
.hint {
  margin: 0 0 4px;
  color: var(--text-muted);
  line-height: 1.6;
}
.hint.boxed {
  margin: 12px 0 4px;
  padding: 8px 10px;
  background: var(--bg-raised);
  border-radius: 4px;
}
</style>

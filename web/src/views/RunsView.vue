<script setup lang="ts">
/**
 * 作業紀錄。**這一頁是「擷取不是黑箱」的體現**（ui-workflows）。
 *
 * 三件事一定要看得見：
 *   1. **節流狀態列一直在畫面上** —— 它是這個工具對外的行為承諾
 *   2. **每一項的失敗各自帶自己的碼與繁中訊息**，不是一個「匯入失敗」
 *   3. **`部分失敗` 不是「失敗」的一種**：成功幾個、失敗幾個、原因各是什麼
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  api,
  type Angle,
  type ApiError,
  type FetchPolicy,
  type RebuildReport,
  type Run,
  type RunItem,
} from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';

const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params['slug'] ?? ''));
const runId = computed(() => {
  const raw = route.params['runId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const runList = ref<Run[]>([]);
const run = ref<Run | null>(null);
const runItems = ref<RunItem[]>([]);
const runAngles = ref<Angle[]>([]);
const error = ref<ApiError | null>(null);

// ── 擴展────────────────────────────────────────
//
// **兩階段之間有一個人。** `startExpansion` 回的是子問題清單而不會開始抓，
// 使用者勾選之後 `chooseAngles` 才真的開始（REQ-0004 的驗收條件）。
const topic = ref('');
const expanding = ref(false);
/** 第一階段的結果。**不是 null 就代表「等你勾」**，而畫面要說出這件事 */
const draft = ref<{ runId: string; angles: Angle[]; seededFrom: number } | null>(null);
const picked = ref<Set<string>>(new Set());
/** 跟 `MAX_SELECTED_ANGLES` 一致 —— 每條角度要花 2 次呼叫 */
const MAX_PICK = 5;

const urls = ref('');
const busy = ref(false);
const dragging = ref(false);
const throttleNow = ref<{ host: string; ms: number } | null>(null);
/** 那一列的數字從程式讀（`/api/system/fetch-policy`），不寫死在 i18n 裡。 */
const policy = ref<FetchPolicy | null>(null);
void api.fetchPolicy().then((r) => {
  if (r.ok) policy.value = r.data;
});

let stream: EventSource | null = null;

function closeStream(): void {
  stream?.close();
  stream = null;
  throttleNow.value = null;
}
onUnmounted(closeStream);

async function loadRuns(): Promise<void> {
  const result = await api.runs(slug.value);
  if (result.ok) runList.value = result.data;
  else error.value = result.error;
}

async function loadRun(): Promise<void> {
  const id = runId.value;
  closeStream();
  run.value = null;
  runItems.value = [];
  runAngles.value = [];
  if (id === null) return;

  const result = await api.run(slug.value, id);
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  run.value = result.data.run;
  runItems.value = result.data.items;
  runAngles.value = result.data.angles;

  // 還在跑就接上 SSE。**跑完了就不接** —— 那條端點會立刻回一個結束事件。
  if (result.data.run.live) subscribe(id);
}

function subscribe(id: string): void {
  stream = new EventSource(api.runEventsUrl(slug.value, id));
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data as string) as Record<string, unknown>;
    if (event['type'] === 'throttled') {
      throttleNow.value = { host: String(event['host']), ms: Number(event['waitedMs']) };
    }
    if (event['type'] === 'item' || event['type'] === 'angle' || event['type'] === 'settled') {
      throttleNow.value = null;
      void refreshRun(id);
    }
    if (event['type'] === 'settled') {
      closeStream();
      void loadRuns();
    }
  };
  stream.onerror = () => closeStream();
}

async function refreshRun(id: string): Promise<void> {
  const result = await api.run(slug.value, id);
  if (!result.ok) return;
  run.value = result.data.run;
  runItems.value = result.data.items;
  runAngles.value = result.data.angles;
}

watch(slug, () => void loadRuns(), { immediate: true });
watch(runId, () => void loadRun(), { immediate: true });

function openRun(id: string): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/runs/${encodeURIComponent(id)}`);
}

async function submitUrls(): Promise<void> {
  const list = urls.value
    .split(/[\s]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (list.length === 0) return;

  busy.value = true;
  const result = await api.importUrls(slug.value, list);
  busy.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  urls.value = '';
  await loadRuns();
  openRun(result.data.runId);
}

async function submitFiles(files: FileList | null): Promise<void> {
  if (files === null || files.length === 0) return;
  busy.value = true;
  let lastRun: string | null = null;
  for (const file of Array.from(files)) {
    const result = await api.importFile(slug.value, file);
    if (result.ok) lastRun = result.data.runId;
    else error.value = result.error;
  }
  busy.value = false;
  await loadRuns();
  if (lastRun !== null) openRun(lastRun);
}

/** 產生了角度、還沒勾的擴展。`queued` 在匯入上是真的在排隊，在擴展上是「在等你勾」（state-machines.md）。 */
function isDraft(r: Run): boolean {
  return r.kind === 'expand' && r.status === 'queued' && !r.live;
}

async function discard(r: Run): Promise<void> {
  if (!window.confirm(t.runControl.discardConfirm)) return;
  busyControl.value = true;
  const result = await api.discardRun(slug.value, r.id);
  busyControl.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  // 正在看的就是它 —— 回到清單，不留一個指著已經不存在的東西的網址。
  if (runId.value === r.id) void router.replace(`/case/${encodeURIComponent(slug.value)}/runs`);
  await loadRuns();
}

/** 這一次寫進去最多關聯的那一份資料 —— 「在關聯圖上看」的焦點。沒寫進任何東西就沒有這顆按鈕。 */
const graphFocusId = computed<string | null>(() => {
  let best: RunItem | null = null;
  for (const row of runItems.value) {
    if (row.itemId === null || row.newEdges <= 0) continue;
    if (best === null || row.newEdges > best.newEdges) best = row;
  }
  return best?.itemId ?? null;
});

function showOnGraph(): void {
  const focus = graphFocusId.value;
  if (focus === null) return;
  void router.push({
    path: `/case/${encodeURIComponent(slug.value)}`,
    query: { focus },
  });
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void submitFiles(event.dataTransfer?.files ?? null);
}

// ── 擴展的兩步 ────────────────────────────────────────────

async function proposeAngles(): Promise<void> {
  const value = topic.value.trim();
  if (value.length === 0) return;
  expanding.value = true;
  error.value = null;
  const result = await api.startExpansion(slug.value, value);
  expanding.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  draft.value = {
    runId: result.data.runId,
    angles: result.data.angles,
    seededFrom: result.data.seededFrom,
  };
  picked.value = new Set();
}

function togglePick(id: string): void {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else if (next.size < MAX_PICK) next.add(id);
  picked.value = next;
}

async function startPicked(): Promise<void> {
  const current = draft.value;
  if (current === null || picked.value.size === 0) return;
  expanding.value = true;
  const result = await api.chooseAngles(slug.value, current.runId, [...picked.value]);
  expanding.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  topic.value = '';
  draft.value = null;
  await loadRuns();
  openRun(current.runId);
}

/**
 * 「花了多少」這一句有三種，**而它們說的是三件不同的事**（ADR-0006 的補記）。
 *
 * `null` ＝ provider 沒回報；`0` ＝ 本機執行、金額成本真的是零。
 * 兩者都寫成「$0.00」的話，對前者是一句謊。
 */
/**
 * 這一次用了哪些模型。
 *
 * **換一個模型重跑，結果會不一樣** —— 而沒有這一行的話，
 * 兩次結果不同時沒有任何地方查得出「換了模型」這件事。
 */
function providerLabel(r: Run): string {
  if (r.providers === null) return '';
  try {
    // `chatExtract` 只在**抽取跑在另一個模型上**時才有值（逐任務覆寫）。
    // 舊的紀錄沒有這個鍵，而那跟「兩個任務同一個模型」在畫面上是同一件事。
    const parsed = JSON.parse(r.providers) as {
      chat?: unknown;
      chatExtract?: unknown;
      agent?: unknown;
    };
    return [parsed.chat, parsed.chatExtract, parsed.agent]
      .filter((v) => typeof v === 'string')
      .join(' ＋ ');
  } catch {
    // 這一欄是說明不是規則 —— 壞掉就不顯示，不要為它讓整頁失敗
    return '';
  }
}

function costText(r: Run): string {
  if (r.costUsd === null) return t.expand.costUnknown;
  if (r.costUsd === 0) return t.expand.costLocal;
  return fill(t.expand.cost, { usd: r.costUsd.toFixed(4) });
}

async function cancel(): Promise<void> {
  const id = runId.value;
  if (id === null) return;
  const result = await api.cancelRun(slug.value, id);
  if (!result.ok) error.value = result.error;
}

/**
 * 暫停與繼續。**跟取消是三顆不同的按鈕，而它們的差別要看得出來** ——
 * 暫停會回來，取消不會，復原是把已經寫進去的拿掉。
 */
const busyControl = ref(false);

async function pauseOrResume(paused: boolean): Promise<void> {
  const id = runId.value;
  if (id === null) return;
  busyControl.value = true;
  const result = paused ? await api.resumeRun(slug.value, id) : await api.pauseRun(slug.value, id);
  busyControl.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  await openRun(id);
}

/** 復原的結果要說出「留下了什麼」，不然使用者會問「為什麼圖上還有」。 */
const undoNote = ref<string | null>(null);

async function undo(): Promise<void> {
  const id = runId.value;
  if (id === null) return;
  if (!window.confirm(t.runControl.undoConfirm)) return;

  busyControl.value = true;
  const result = await api.undoRun(slug.value, id);
  busyControl.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }

  const r = result.data;
  const parts: string[] = [];
  if (r.deletedItems === 0 && r.deletedEdges === 0) {
    parts.push(t.runControl.undoNothing);
  } else {
    parts.push(fill(t.runControl.undone, { items: r.deletedItems, edges: r.deletedEdges }));
  }
  if (r.deletedEntities > 0) {
    parts.push(fill(t.runControl.undoneEntities, { n: r.deletedEntities }));
  }
  if (r.partial) {
    parts.push(fill(t.runControl.undoKept, { items: r.keptItems, edges: r.keptEdges }));
    if (r.keptAsEvidence > 0) {
      parts.push(fill(t.runControl.undoKeptEvidence, { n: r.keptAsEvidence }));
    }
  }
  undoNote.value = parts.join(' ');
  await openRun(id);
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('zh-Hant');
}

function noteOf(item: RunItem): string {
  if (item.code === null) return '';
  return errorMessages[item.code] ?? item.code;
}

function openItem(id: string | null): void {
  if (id === null) return;
  void router.push(`/case/${encodeURIComponent(slug.value)}/reader/${encodeURIComponent(id)}`);
}

// ── `derived/` 整批重算────────────────────────

const rebuilding = ref(false);
const rebuildReport = ref<RebuildReport | null>(null);

/**
 * 按下去會把這個專題的正文全部重抽一次。
 *
 * **先問一次**，因為它會跑一段時間而且會改畫面上的東西 ——
 * 而那句確認同時要說清楚它**不會**動到什麼（快照、已排除、已確認）。
 */
async function rebuild(): Promise<void> {
  if (!window.confirm(t.rebuild.confirm)) return;
  rebuilding.value = true;
  rebuildReport.value = null;
  const result = await api.rebuild(slug.value);
  rebuilding.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  rebuildReport.value = result.data;
  await loadRuns();
}
</script>

<template>
  <!--
    捲動的是外層，寬度是內層（base.css）。表格頁用寬的那一種頁寬；
    上面兩張卡（匯入、擴展）在寬畫面上並排 —— 它們是兩件平行的事，不是先後。
  -->
  <main class="scroll">
    <div class="page wide">
      <div class="top">
        <section class="card import" :class="{ dragging }">
          <h2>{{ t.runs.newImport }}</h2>

          <label class="field wide">
            <span>{{ t.runs.urlsLabel }}</span>
            <textarea v-model="urls" rows="3" :placeholder="t.runs.urlsPlaceholder"></textarea>
          </label>

          <div class="import-actions">
            <button
              class="primary"
              :disabled="busy || urls.trim().length === 0"
              @click="submitUrls"
            >
              {{ busy ? t.runs.uploading : t.runs.submitUrls }}
            </button>
            <label class="btn">
              {{ t.runs.picking }}
              <input
                type="file"
                multiple
                hidden
                @change="submitFiles(($event.target as HTMLInputElement).files)"
              />
            </label>
          </div>

          <div
            class="drop"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            {{ t.runs.dropHint }}
          </div>
        </section>

        <!--
      擴展。**兩階段之間有一個人**（REQ-0004）——
      第一步只產生子問題，畫面上要說出「還沒有開始抓」。
    -->
        <section class="card expand">
          <h2>{{ t.expand.title }}</h2>

          <label class="field wide">
            <span>{{ t.expand.topicLabel }}</span>
            <input v-model="topic" type="text" :placeholder="t.expand.topicPlaceholder" />
          </label>

          <div class="import-actions">
            <button :disabled="expanding || topic.trim().length === 0" @click="proposeAngles">
              {{ expanding ? t.expand.working : t.expand.submit }}
            </button>
          </div>

          <div v-if="draft" class="angles">
            <h3>{{ t.expand.anglesTitle }}</h3>
            <!-- **這一句一定要在。** 第一階段結束時什麼都還沒抓 -->
            <p class="callout pending">{{ t.expand.notYet }}</p>
            <p class="muted">
              {{
                draft.seededFrom > 0
                  ? fill(t.expand.seededFrom, { n: draft.seededFrom })
                  : t.expand.seededFromNothing
              }}
            </p>

            <ul class="angle-list">
              <li v-for="angle in draft.angles" :key="angle.id">
                <label :class="{ picked: picked.has(angle.id) }">
                  <input
                    type="checkbox"
                    :checked="picked.has(angle.id)"
                    @change="togglePick(angle.id)"
                  />
                  <span class="q">{{ angle.question }}</span>
                  <span v-if="angle.stance" class="stance">{{ angle.stance }}</span>
                </label>
                <!--
              **設計稿在這裡寫的是「預估會找到幾個」** —— 那個數字只可能是模型猜的。
              這一行是我們查得到也驗得了的：這條角度是從你已有的哪幾份長出來的。
            -->
                <p class="seeds">
                  <template v-if="angle.seeds.length > 0">
                    {{ t.expand.seedsLabel }}：{{ angle.seeds.map((s) => s.title).join('、') }}
                  </template>
                  <template v-else>{{ t.expand.noSeeds }}</template>
                </p>
              </li>
            </ul>

            <div class="import-actions">
              <button
                class="primary"
                :disabled="expanding || picked.size === 0"
                @click="startPicked"
              >
                {{ fill(t.expand.start, { n: picked.size }) }}
              </button>
              <span class="muted small">
                {{
                  picked.size === 0
                    ? t.expand.pickAtLeastOne
                    : fill(t.expand.tooMany, { n: MAX_PICK })
                }}
              </span>
            </div>

            <p class="muted small">{{ t.expand.machineOnly }}</p>
          </div>
        </section>
      </div>

      <!-- **這一列一直在畫面上。** 它是這個工具對外的行為承諾。 -->
      <section class="throttle">
        <span class="label">{{ t.runs.throttleTitle }}</span>
        <span v-if="policy" class="rule">
          {{ fill(t.runs.throttleInterval, { seconds: policy.intervalMs / 1000 }) }}
        </span>
        <span v-if="policy" class="rule">
          {{ fill(t.runs.throttleBackoff, { n: policy.maxRetries }) }}
        </span>
        <span class="rule">{{ t.runs.throttleRobots }}</span>
        <span v-if="throttleNow" class="now">
          {{ fill(t.runs.throttleNow, { host: throttleNow.host, ms: throttleNow.ms }) }}
        </span>
      </section>

      <!-- `derived/` 整批重算。**衍生物可以丟掉重來，而那件事要有一條真的跑得起來的路。** -->
      <section class="rebuild">
        <button :disabled="rebuilding" @click="rebuild">
          {{ rebuilding ? t.rebuild.running : t.rebuild.button }}
        </button>
        <p v-if="rebuildReport" class="report">
          <span>{{
            fill(t.rebuild.done, {
              items: rebuildReport.items,
              reextracted: rebuildReport.reextracted,
            })
          }}</span>
          <span v-if="rebuildReport.failed > 0" class="warn">
            {{ fill(t.rebuild.failed, { n: rebuildReport.failed }) }}
          </span>
          <span v-if="rebuildReport.snapshotMissing > 0" class="warn">
            {{ fill(t.rebuild.missing, { n: rebuildReport.snapshotMissing }) }}
          </span>
          <span v-if="rebuildReport.notes.checked === 0" class="muted">{{
            t.rebuild.noNotes
          }}</span>
          <template v-else>
            <span v-if="rebuildReport.notes.unresolved === 0 && rebuildReport.notes.shifted === 0">
              {{ fill(t.rebuild.notesOk, { n: rebuildReport.notes.checked }) }}
            </span>
            <span v-if="rebuildReport.notes.shifted > 0" class="warn">
              {{ fill(t.rebuild.notesShifted, { n: rebuildReport.notes.shifted }) }}
            </span>
            <span v-if="rebuildReport.notes.unresolved > 0" class="warn">
              {{ fill(t.rebuild.notesUnresolved, { n: rebuildReport.notes.unresolved }) }}
            </span>
          </template>
        </p>
      </section>

      <ErrorPanel v-if="error" :error="error" />

      <div class="split">
        <aside class="list">
          <h2>{{ t.runs.title }}</h2>
          <p v-if="runList.length === 0" class="muted">{{ t.runs.empty }}</p>
          <ul v-else class="rows">
            <li v-for="r in runList" :key="r.id">
              <button class="row" :class="{ active: r.id === runId }" @click="openRun(r.id)">
                <span class="row-title">{{ r.label }}</span>
                <span class="row-meta">
                  <!-- 沒勾就走掉的擴展停在 queued。**它不是在排隊，是在等一個不會來的人** —— 標成草稿。 -->
                  <span v-if="isDraft(r)" class="badge draft">{{ t.runControl.draft }}</span>
                  <span v-else :class="['badge', r.status]">{{ t.runStatus[r.status] }}</span>
                  <span v-if="r.live" class="live">{{ t.runs.live }}</span>
                  <span>{{ when(r.createdAt) }}</span>
                </span>
              </button>
              <button
                v-if="isDraft(r)"
                class="discard quiet small"
                :disabled="busyControl"
                @click="discard(r)"
              >
                {{ t.runControl.discard }}
              </button>
            </li>
          </ul>
        </aside>

        <section v-if="run" class="detail">
          <header class="detail-head">
            <h2>{{ run.label }}</h2>
            <!--
            **擴展數的是角度，匯入數的是網址** —— 兩種 run 的「一項」不一樣，
            所以句子也不一樣。共用一句的話，畫面上會出現「共 1 項」
            配著下面六列網址。
          -->
            <p class="counts">
              <span :class="['badge', run.status]">{{ t.runStatus[run.status] }}</span>
              {{
                fill(run.kind === 'expand' ? t.expand.counts : t.runs.counts, {
                  succeeded: run.succeeded,
                  failed: run.failed,
                  total: run.total,
                })
              }}
            </p>
            <!--
            **「已取消」有三種來源，而使用者只按過其中一種。**
            沒有這一句的話，一個被強制結束留下來的作業看起來像
            「我自己取消了它」—— 而那件事沒有發生過。
          -->
            <p v-if="run.endedReason" class="ended-reason">
              {{ t.runEndedReason[run.endedReason] }}
            </p>
            <div class="controls">
              <template v-if="run.live">
                <button :disabled="busyControl" @click="pauseOrResume(run.paused)">
                  {{ run.paused ? t.runControl.resume : t.runControl.pause }}
                </button>
                <button @click="cancel">{{ t.runs.cancel }}</button>
                <span v-if="run.paused" class="paused">{{ t.runControl.paused }}</span>
                <span v-else class="hint">{{ t.runControl.pauseHint }}</span>
              </template>
              <!-- 草稿沒有東西可以復原，只有丟掉。 -->
              <button v-else-if="isDraft(run)" :disabled="busyControl" @click="discard(run)">
                {{ t.runControl.discard }}
              </button>
              <!-- **跑完才給復原。** 一邊寫一邊刪會留下說不清楚的狀態。 -->
              <template v-else>
                <!--
                回圖上看。**焦點放在這一次新增關聯最多的那一份** ——
                2026-09-18 使用者跑完擴展回到圖上，看到的還是先前那一個點：
                圖用的是舊焦點，而那份 PDF 一條邊都沒有。
              -->
                <button v-if="graphFocusId !== null" @click="showOnGraph">
                  {{ t.runs.showOnGraph }}
                </button>
                <button :disabled="busyControl" @click="undo">
                  {{ t.runControl.undo }}
                </button>
              </template>
            </div>
          </header>

          <p v-if="undoNote" class="undo-note">{{ undoNote }}</p>

          <!--
          擴展這一次花了什麼。**請求數是主要上限**（ADR-0006 的補記），
          而金額只在 provider 真的回報時才是一個數字。
        -->
          <!--
          **主題不在這裡。** 擴展的 `label` 就是 `topic` ——
          上面那個標題已經是它了，再寫一次只是同一句話出現兩遍。
        -->
          <p v-if="run.kind === 'expand'" class="budget">
            <span>{{ fill(t.expand.requests, { n: run.requests }) }}</span>
            <span>{{ costText(run) }}</span>
            <span v-if="run.providers" class="mono">{{
              fill(t.expand.usedProviders, { chat: providerLabel(run) })
            }}</span>
          </p>

          <!-- 沒被勾的那幾條也在這裡 —— 作業紀錄要看得出當時有哪些選項 -->
          <table v-if="runAngles.length > 0" class="table angle-table">
            <thead>
              <tr>
                <th>{{ t.expand.colAngle }}</th>
                <th>{{ t.expand.colStance }}</th>
                <th>{{ t.expand.colFound }}</th>
                <th>{{ t.expand.colNodes }}</th>
                <th>{{ t.expand.colEdges }}</th>
                <th>{{ t.expand.colNote }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="angle in runAngles" :key="angle.id" :class="{ skipped: !angle.selected }">
                <td>{{ angle.question }}</td>
                <td class="stance-cell">{{ angle.stance }}</td>
                <td class="num">{{ angle.selected ? angle.foundUrls : '' }}</td>
                <td class="num">{{ angle.selected ? angle.newNodes : '' }}</td>
                <td class="num">{{ angle.selected ? angle.newEdges : '' }}</td>
                <td class="note">
                  {{
                    angle.selected
                      ? angle.code
                        ? (errorMessages[angle.code] ?? angle.code)
                        : ''
                      : t.expand.notSelected
                  }}
                </td>
              </tr>
            </tbody>
          </table>

          <table class="table">
            <thead>
              <tr>
                <th>{{ t.runs.colStatus }}</th>
                <th>{{ t.runs.colSource }}</th>
                <th>{{ t.runs.colHost }}</th>
                <th>{{ t.runs.colNodes }}</th>
                <th>{{ t.runs.colEdges }}</th>
                <th>{{ t.runs.colNote }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in runItems" :key="item.id">
                <td>
                  <span :class="['badge', item.outcome]">{{ t.runOutcome[item.outcome] }}</span>
                </td>
                <td class="src">
                  <button v-if="item.itemId" class="link" @click="openItem(item.itemId)">
                    {{ item.requested }}
                  </button>
                  <span v-else>{{ item.requested }}</span>
                </td>
                <td class="mono">{{ item.host ?? '' }}</td>
                <td class="num">{{ item.newNodes }}</td>
                <td class="num">{{ item.newEdges }}</td>
                <td class="note">
                  {{ noteOf(item) }}
                  <span v-if="item.waitedMs" class="muted waited">
                    {{ fill(t.runs.waited, { ms: item.waitedMs }) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
/* 頁寬、卡片、標題、表格、表單、按鈕都在 base.css；這裡只有這一頁自己的東西。 */
.top {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s4);
  align-items: start;
}
/* 並排的兩張卡不吃 base.css 的 `.card + .card` 上邊距。 */
.top .card + .card {
  margin-top: 0;
}
@media (max-width: 900px) {
  .top {
    grid-template-columns: 1fr;
  }
}

.rebuild {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
}

.rebuild .report {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: var(--fs-label);
  line-height: 1.6;
  color: var(--text-secondary);
}

.rebuild .warn {
  color: var(--edge-pending);
}

.angles h3 {
  margin: 14px 0 6px;
}
.angle-list {
  list-style: none;
  padding: 0;
  margin: 10px 0;
  display: grid;
  gap: 8px;
}
.angle-list label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-small);
  cursor: pointer;
}
.angle-list label.picked .q {
  color: var(--text);
}
.angle-list .q {
  color: var(--text-secondary);
}
.stance {
  font-size: var(--fs-label);
  color: var(--text-muted);
  border: 1px solid var(--line-subtle);
  border-radius: 999px;
  padding: 0 8px;
}
.seeds {
  font-size: var(--fs-label);
  color: var(--text-muted);
  margin: 2px 0 0 24px;
}
.budget {
  display: flex;
  gap: 14px;
  font-size: var(--fs-label);
  color: var(--text-tertiary);
  margin: 0 0 10px;
}
.angle-table {
  margin-bottom: 16px;
}
/* 立場只有三四個字，不讓它折成一行一個字。 */
.stance-cell {
  white-space: nowrap;
}
/* 沒被勾的那幾條淡一點，**但仍然看得到** —— 它們是這次作業的一部分 */
.angle-table tr.skipped td {
  color: var(--text-muted);
}
.import.dragging {
  border-color: var(--ui-action);
}
.import-actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
  align-items: center;
  flex-wrap: wrap;
}
.drop {
  border: 1px dashed var(--line-muted);
  border-radius: var(--radius);
  padding: 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-label);
}
.throttle {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 14px 0;
  padding: 8px 12px;
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
  font-size: var(--fs-label);
  color: var(--text-tertiary);
}
.throttle .label {
  color: var(--text-secondary);
  font-weight: 600;
}
.throttle .rule::before {
  content: '· ';
}
.throttle .now {
  color: var(--edge-pending);
  margin-left: auto;
}
.split {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: 20px;
  margin-top: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .split {
    grid-template-columns: 1fr;
  }
}
.list h2,
.detail-head h2 {
  margin-bottom: 10px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* 草稿那一列右邊多一顆「丟掉」。列本身是一顆按鈕，所以丟掉不能包在它裡面（按鈕裡不能有按鈕）。 */
.rows li {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.rows li .row {
  flex: 1 1 auto;
  min-width: 0;
}
.discard {
  flex: none;
  margin-top: 8px;
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
.row-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 3px;
  font-size: var(--fs-label);
  color: var(--text-muted);
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.controls .hint,
.controls .paused {
  font-size: var(--fs-label);
  color: var(--text-muted);
}
/* 暫停中用琥珀 —— 它是一個「還沒結束、等著你」的狀態，
   跟待查證同一類。綠色在這個工具裡只有「確認」一個意思。 */
.controls .paused {
  color: var(--edge-pending);
}
.undo-note {
  margin: 8px 0 0;
  font-size: var(--fs-label);
  line-height: 1.7;
  color: var(--text-secondary);
}

.live {
  color: var(--ui-action);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.counts {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-small);
  display: flex;
  align-items: center;
  gap: 8px;
}
.ended-reason {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: var(--fs-small);
}
.detail .table {
  margin-top: 12px;
}
.detail .num {
  width: 72px;
}
.src {
  max-width: 320px;
  word-break: break-all;
}
.note {
  color: var(--text-secondary);
}
.waited {
  display: block;
  font-size: var(--fs-label);
}
.detail .link {
  text-align: left;
  font-weight: 400;
}
/* 狀態徽章的顏色。**狀態一律是文字，顏色只是輔助** —— 綠對紅在綠紅色盲下只差 ΔE 2.2（ADR-0018）。 */
.badge.done,
.badge.ok {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.badge.partial,
.badge.running,
.badge.queued,
.badge.duplicate {
  border-color: var(--edge-pending);
  color: var(--edge-pending);
}
.badge.failed {
  border-color: var(--ui-danger);
  color: var(--ui-danger);
}
/* 草稿不是一個「狀態」，它是還沒發生 —— 不上色。 */
.badge.draft {
  border-color: var(--line-muted);
  color: var(--text-tertiary);
}
</style>

<script setup lang="ts">
/**
 * 「研究」：規劃（Stage 19）與蒐集（Stage 20）。ADR-0033 D2／D3／D5／D7，REQ-0009 R1–R13。
 *
 * ## 這個元件的每一塊都在回答「現在花了什麼、機器在做什麼、輪到誰」
 *
 * 舊的擴展按下去就開始搜尋、抓取、抽取，而使用者看不到模型打算怎麼找
 * （2026-09-18 的第 12 點）。所以這裡：
 *
 * - 開一次研究之前先說「只會查你已經有的資料，不花錢」
 * - 談一輪、閘門一、繼續蒐集的按鈕旁邊說走哪個服務、會不會花錢
 * - 蒐集的時候照方向分組列出每一個候選：抓到了、要你拿（**而且說得出為什麼**）、拿不到
 * - 蒐集停在半路（程式關掉了）、你按了取消、機器做完了輪到你 —— 三種說法不一樣
 *
 * ## 方向是可以直接改的（R4）
 *
 * 改動先留在本地（`draft`），按「存下改過的方向」才送出去 ——
 * 每打一個字就送一次的話，一次研究會在伺服器上留下幾十個版本，
 * 而使用者**看不出哪一版是他要的那一版**。
 *
 * ## 哪一列可以按什麼，不是這裡判斷的
 *
 * 每一列候選帶著 `actions`（伺服器的 `mayActOnCandidate`）。畫面自己判斷的話，
 * 兩邊的規則遲早會不一樣 —— 而使用者看到的是一顆按了就報錯的按鈕。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import {
  api,
  type ApiError,
  type ApiResult,
  type Candidate,
  type DirectionInput,
  type FrozenDirection,
  type Research,
  type ResearchDeletion,
  type ServiceView,
  type UnavailableReason,
} from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{
  (e: 'error', error: ApiError | null): void;
  /**
   * 作業清單可能變了（閘門一、繼續蒐集、上傳、蒐集收尾、放棄）。**這一頁下面那張作業紀錄只在打開時讀一次**，
   * 不通知的話，剛開出來的那幾筆要重新整理才看得到（D10 截圖看出來的）。
   */
  (e: 'runs-changed'): void;
}>();
const router = useRouter();

const list = ref<Research[]>([]);
const current = ref<Research | null>(null);
const topic = ref('');
const said = ref('');
const busy = ref<'' | 'start' | 'say' | 'save' | 'gate' | 'other'>('');
const deletion = ref<ResearchDeletion | null>(null);
/** 正在處理的那一列候選（上傳、標拿不到）。**一次只動一列**，其餘的按鈕照常可以按。 */
const busyRow = ref<string | null>(null);
/** 方向的本地版本。**送出去之前不動伺服器上那一份。** */
const draft = ref<DirectionInput[]>([]);
/** 每一列「拿不到的原因」的選擇與那一句自由填的話。 */
const reasonDraft = ref<Record<string, UnavailableReason>>({});
const noteDraft = ref<Record<string, string>>({});
const throttleNow = ref<{ host: string; ms: number } | null>(null);
/** 哪一列的「拿不到的原因」攤開了。**一次一列** —— 每一列都攤開一個下拉選單太重。 */
const reasonOpen = ref<string | null>(null);

const UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
  'paywall',
  'not-found',
  'blocked',
  'other',
];

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
/** 「Claude Code · 模型」—— 模型名空著代表走那個服務自己的預設，只寫服務。 */
function serviceNameOf(s: ServiceView): string {
  const name = t.settings.connectionNames[s.via];
  return s.model.length === 0 ? name : `${name} · ${s.model}`;
}
/** 「「服務」· 會花錢」—— 閘門與「繼續蒐集」旁邊，每一步各自說（ADR-0033 D2）。 */
function costLabelOf(s: ServiceView): string {
  return fill(s.costs ? t.research.serviceCosts : t.research.serviceFree, {
    service: serviceNameOf(s),
  });
}

/** 還沒做完的那幾種 —— **只列不是 0 的**。 */
const workLeftText = computed(() => {
  const work = open.value?.collect.work;
  if (work === undefined) return '';
  const parts: string[] = [];
  if (work.searches > 0) parts.push(fill(t.research.workSearches, { n: work.searches }));
  if (work.fetches > 0) parts.push(fill(t.research.workFetches, { n: work.fetches }));
  if (work.digests > 0) parts.push(fill(t.research.workDigests, { n: work.digests }));
  return parts.length === 0 ? '' : fill(t.research.workLeft, { parts: parts.join('、') });
});

/**
 * 「繼續蒐集」按下去會做哪幾步、各走哪個服務。**新抓到的也會被讀** ——
 * 所以只要還有要抓的，初讀那一句就要在。
 */
const resumeText = computed(() => {
  const r = open.value;
  if (r === null) return '';
  const { searches, fetches, digests } = r.collect.work;
  const parts: string[] = [];
  if (searches > 0) {
    parts.push(fill(t.research.resumeSearch, { service: costLabelOf(r.findService) }));
  }
  if (fetches > 0) parts.push(t.research.resumeFetch);
  if (digests > 0 || fetches > 0 || searches > 0) {
    parts.push(fill(t.research.resumeDigest, { service: costLabelOf(r.digestService) }));
  }
  return parts.length === 0 ? '' : fill(t.research.resumeParts, { parts: parts.join('；') });
});

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

// **只在換了一次研究、或規劃真的變了的時候重排本地版本** —— 蒐集中每抓到一份就會重讀一次，
// 那時候把使用者正在打的字蓋掉是最糟的一種「畫面自己在動」。
watch(
  () => [current.value?.id, JSON.stringify(current.value?.plan.directions ?? [])] as const,
  syncDraft,
);

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

watch(
  () => props.slug,
  () => {
    deletion.value = null;
    void load();
  },
  { immediate: true },
);

// ── 蒐集中：接上作業的進度（SSE）───────────────────────────
//
// 研究本身沒有進度通道 —— 做事的是那一筆作業（D3）。所以接的是作業的那一條，
// 而每一個「做完了一步」的事件都重讀一次整份研究：候選表、數字、按鈕都跟著它。

let stream: EventSource | null = null;
let streamRun: string | null = null;
let refreshing = false;
let refreshAgain = false;

function closeStream(): void {
  stream?.close();
  stream = null;
  streamRun = null;
  throttleNow.value = null;
}
onUnmounted(closeStream);

async function refresh(): Promise<void> {
  const id = current.value?.id;
  if (id === undefined) return;
  // **同時只重讀一次**：抓得快的時候事件一秒好幾個，每一個都送一次請求沒有意義。
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const res = await api.getResearch(props.slug, id);
  refreshing = false;
  if (res.ok && current.value?.id === id) current.value = res.data;
  if (refreshAgain) {
    refreshAgain = false;
    await refresh();
  }
}

watch(
  () =>
    current.value?.status === 'building'
      ? ([current.value.build.live, current.value.build.runId] as const)
      : ([current.value?.collect.live, current.value?.collect.runId] as const),
  ([live, runId]) => {
    if (live !== true || runId === null || runId === undefined) {
      closeStream();
      return;
    }
    if (streamRun === runId) return;
    closeStream();
    streamRun = runId;
    stream = new EventSource(api.runEventsUrl(props.slug, runId));
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as Record<string, unknown>;
      if (event['type'] === 'throttled') {
        throttleNow.value = { host: String(event['host']), ms: Number(event['waitedMs']) };
        return;
      }
      if (
        event['type'] === 'item' ||
        event['type'] === 'direction' ||
        event['type'] === 'progress'
      ) {
        throttleNow.value = null;
        void refresh();
      }
      if (event['type'] === 'settled') {
        closeStream();
        void refresh().then(load);
        emit('runs-changed');
      }
    };
    stream.onerror = () => {
      closeStream();
      void refresh();
    };
  },
);

// ── 規劃 ────────────────────────────────────────────────────

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

async function assessGap(): Promise<void> {
  const id = open.value?.id;
  if (id === undefined) return;
  busy.value = 'other';
  report(null);
  try {
    const res = await api.assessResearchGap(props.slug, id);
    if (res.ok) current.value = res.data;
    else {
      report(res.error);
      await refresh();
    }
  } finally {
    busy.value = '';
  }
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

/** 一顆會改狀態的按鈕：按下去、換成回來的那一份、重讀清單。 */
async function act(
  kind: typeof busy.value,
  call: () => Promise<ApiResult<Research>>,
): Promise<void> {
  busy.value = kind;
  report(null);
  const res = await call();
  busy.value = '';
  if (!res.ok) {
    report(res.error);
    await refresh();
    return;
  }
  current.value = res.data;
  await load();
  emit('runs-changed');
}

function gateOne(): void {
  const id = open.value?.id;
  if (id !== undefined) void act('gate', () => api.startCollecting(props.slug, id));
}

function abandon(): void {
  const id = open.value?.id;
  if (id !== undefined) void act('other', () => api.abandonResearch(props.slug, id));
}

// ── 蒐集 ────────────────────────────────────────────────────

function resumeCollecting(): void {
  const id = open.value?.id;
  if (id !== undefined) void act('gate', () => api.resumeCollecting(props.slug, id));
}

function gateTwo(): void {
  const id = open.value?.id;
  if (id !== undefined) void act('gate', () => api.finishCollecting(props.slug, id));
}

/** 暫停／繼續／取消。**這三顆是作業的**（同作業紀錄那一頁），不是研究的。 */
async function control(what: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const runId =
    open.value?.status === 'building' ? open.value.build.runId : open.value?.collect.runId;
  if (runId === null || runId === undefined) return;
  report(null);
  const res =
    what === 'pause'
      ? await api.pauseRun(props.slug, runId)
      : what === 'resume'
        ? await api.resumeRun(props.slug, runId)
        : await api.cancelRun(props.slug, runId);
  if (!res.ok) report(res.error);
  await refresh();
}

async function onRow(c: Candidate, call: () => Promise<ApiResult<Research>>): Promise<void> {
  busyRow.value = c.id;
  report(null);
  const res = await call();
  busyRow.value = null;
  if (!res.ok) {
    report(res.error);
    await refresh();
    return;
  }
  current.value = res.data;
  emit('runs-changed');
}

function uploadFor(c: Candidate, event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const id = open.value?.id;
  if (file === undefined || id === undefined) return;
  void onRow(c, () => api.uploadCandidate(props.slug, id, c.id, file));
}

function markUnavailable(c: Candidate): void {
  const id = open.value?.id;
  if (id === undefined) return;
  const reason = reasonDraft.value[c.id] ?? 'paywall';
  const note = noteDraft.value[c.id] ?? '';
  reasonOpen.value = null;
  void onRow(c, () => api.markCandidateUnavailable(props.slug, id, c.id, reason, note));
}

function reopen(c: Candidate): void {
  const id = open.value?.id;
  if (id !== undefined) void onRow(c, () => api.reopenCandidate(props.slug, id, c.id));
}

async function remove(entry: Research): Promise<void> {
  const slug = props.slug;
  deletion.value = null;
  busy.value = 'other';
  report(null);
  const res = await api.deleteResearch(slug, entry.id);
  busy.value = '';
  if (props.slug !== slug) return;
  if (!res.ok) {
    report(res.error);
    return;
  }
  deletion.value = res.data;
}

async function confirmRemove(): Promise<void> {
  const slug = props.slug;
  const preview = deletion.value;
  if (preview === null) return;
  busy.value = 'other';
  report(null);
  const res = await api.deleteResearch(slug, preview.id, true);
  busy.value = '';
  if (props.slug !== slug) return;
  if (!res.ok) {
    report(res.error);
    return;
  }
  if (!res.data.done) {
    deletion.value = res.data;
    return;
  }
  deletion.value = null;
  if (current.value?.id === preview.id) current.value = null;
  await load();
}

function openEntry(entry: Research): void {
  current.value = entry;
}

function readItem(itemId: string): void {
  void router.push(`/case/${encodeURIComponent(props.slug)}/reader/${encodeURIComponent(itemId)}`);
}

/**
 * 已經結束的那一次（從「歷次研究」點開）：**唯讀**。
 *
 * v0.25.0 的畫面只認還沒結束的那一次（`open`），點開一次做完的研究只看得到缺口評估 ——
 * 方向、候選、每一列最後的決定、「在關聯圖上看這一次新增的」（R22）都不見了。
 * 2026-10-03 用合成資料截「完成」那一格才看到。這一塊沒有任何會動資料的按鈕。
 */
const finished = computed(() =>
  current.value !== null &&
  (current.value.status === 'done' || current.value.status === 'abandoned')
    ? current.value
    : null,
);

function finishedRowsOf(d: FrozenDirection): Candidate[] {
  return (finished.value?.candidates ?? []).filter((c) => c.directionIds[0] === d.id);
}

/** 一列最後的決定，用確認畫面上那四種說法（有正文的中間那一格叫「只留著，不抽」）。 */
function finalLabelOf(c: Candidate): string {
  if (c.effectiveDecision === 'include') return t.research.decisionInclude;
  if (c.effectiveDecision === 'discard') return t.research.decisionDiscard;
  return c.hasBody ? t.research.decisionKeep : t.research.decisionReference;
}

const finishedSummary = computed(() => {
  const r = finished.value;
  if (r === null) return '';
  const count = (pick: (c: Candidate) => boolean): number => r.candidates.filter(pick).length;
  return fill(t.research.finishedSummary, {
    include: count((c) => c.effectiveDecision === 'include'),
    reference: count((c) => c.effectiveDecision === 'reference' && !c.hasBody),
    keep: count((c) => c.effectiveDecision === 'reference' && c.hasBody),
    discard: count((c) => c.effectiveDecision === 'discard'),
  });
});

/** 焦點是這次研究寫進最多關聯的那一份（伺服器算的，`build.focusItemId`）。 */
function showFinishedOnGraph(): void {
  const focus = finished.value?.build.focusItemId ?? null;
  if (focus === null) return;
  void router.push({ path: `/case/${encodeURIComponent(props.slug)}`, query: { focus } });
}

/** 「其他」要寫一句 —— 那一格空著的時候按鈕不給按。 */
function mayMark(c: Candidate): boolean {
  const reason = reasonDraft.value[c.id] ?? 'paywall';
  return reason !== 'other' || (noteDraft.value[c.id] ?? '').trim().length > 0;
}

/** 採用的方向照順序；沒採用的另外列在最後（劃掉）。 */
const adopted = computed(() => open.value?.directions.filter((d) => d.adopted) ?? []);
const dropped = computed(() => open.value?.directions.filter((d) => !d.adopted) ?? []);

/** 列在這一條底下的：**第一條找到它的是這一條**。別的方向也找到的只列一次。 */
async function build(finish = false): Promise<void> {
  if (open.value === null) return;
  busy.value = 'gate';
  report(null);
  const res = finish
    ? await api.finishBuild(props.slug, open.value.id)
    : await api.buildResearch(props.slug, open.value.id);
  busy.value = '';
  if (!res.ok) report(res.error);
  else current.value = res.data;
  emit('runs-changed');
}

function decide(candidate: Candidate, decision: Candidate['decision']): void {
  if (open.value === null) return;
  const id = open.value.id;
  void onRow(candidate, () => api.decideCandidate(props.slug, id, candidate.id, { decision }));
}

function cite(candidate: Candidate, candidateId: string, event: Event): void {
  if (open.value === null) return;
  const id = open.value.id;
  const checked = (event.target as HTMLInputElement).checked;
  const citedBy = checked
    ? [...candidate.citedBy, candidateId]
    : candidate.citedBy.filter((entry) => entry !== candidateId);
  void onRow(candidate, () => api.decideCandidate(props.slug, id, candidate.id, { citedBy }));
}

function decisionLabel(candidate: Candidate): string {
  if (candidate.decision !== null) return t.research.decisionEdited;
  if (candidate.acquisition !== 'fetched' && candidate.acquisition !== 'uploaded')
    return t.research.decisionNoBody;
  return fill(t.research.decisionDefault, {
    relevance:
      candidate.relevance === null
        ? t.research.digestPending
        : t.research.decisionRelevance[candidate.relevance],
  });
}

function rowsOf(d: FrozenDirection): Candidate[] {
  return (open.value?.candidates ?? []).filter((c) => c.directionIds[0] === d.id);
}

/** 作業活著的時候，第一條還沒搜的就是正在搜的那一條（它照順序搜）。 */
const searchingId = computed(() => {
  const r = open.value;
  if (r === null || !r.collect.live || r.collect.paused) return null;
  return adopted.value.find((d) => d.searchState === 'pending')?.id ?? null;
});

function directionState(d: FrozenDirection): string {
  if (d.searchState === 'failed') {
    const reason = d.searchCode === null ? '' : (errorMessages[d.searchCode] ?? d.searchCode);
    return fill(t.research.directionFailed, { reason });
  }
  if (d.searchState === 'pending') {
    if (searchingId.value === d.id) return t.research.directionSearching;
    return open.value?.collect.live === true
      ? t.research.directionQueued
      : t.research.directionPending;
  }
  if (d.tally.found === 0) return t.research.noCandidates;
  if (open.value?.status === 'reviewing' || open.value?.status === 'building')
    return fill(t.research.reviewTally, { ...d.tally });
  const parts = [fill(t.research.tally, { found: d.tally.found, acquired: d.tally.acquired })];
  if (d.tally.needsUser > 0) parts.push(fill(t.research.tallyNeedsUser, { n: d.tally.needsUser }));
  if (d.tally.unavailable > 0) {
    parts.push(fill(t.research.tallyUnavailable, { n: d.tally.unavailable }));
  }
  if (d.tally.pending > 0) parts.push(fill(t.research.tallyPending, { n: d.tally.pending }));
  return parts.join('、');
}

/**
 * 那一句說明是「要你動手的原因」還是「順帶一提」。**前者醒目、後者淡** ——
 * 抓到了的那幾列常常帶著「抽取信心較低」這種通知，跟「要你拿」的原因一樣醒目的話，
 * 真正要你處理的那幾列就不顯眼了。
 */
function noteIsReason(c: Candidate): boolean {
  return c.acquisition === 'needs-user' || c.acquisition === 'unavailable';
}

/** 一列候選的那一句說明：為什麼要你拿、拿不到的原因、抓到了但有話要說。 */
function noteOf(c: Candidate): string {
  if (c.acquisition === 'unavailable' && c.unavailableReason !== null) {
    const reason = t.research.unavailableReasons[c.unavailableReason];
    const said = c.reasonNote.length > 0 ? `（${c.reasonNote}）` : '';
    return fill(t.research.unavailableShown, { reason: `${reason}${said}` });
  }
  if (c.skipped) {
    return fill(
      c.expectedAccess === 'blocked' ? t.research.skippedBlocked : t.research.skippedLogin,
      {
        host: c.host,
      },
    );
  }
  if (c.code === null) return '';
  return errorMessages[c.code] ?? c.code;
}

function bibOf(c: Candidate): string {
  return [c.bib.authors, c.bib.year, c.bib.venue].filter((s) => s.length > 0).join(' · ');
}

/** 蒐集那一段現在是哪一種情況。**三種「沒有在跑」要說成三句不同的話**（見檔頭）。 */
const collectState = computed<
  'live' | 'paused' | 'interrupted' | 'awaiting' | 'cancelled' | 'failed' | 'reviewing' | null
>(() => {
  const r = open.value;
  if (r === null || r.status === 'planning') return null;
  if (r.status === 'reviewing') return 'reviewing';
  if (r.collect.live) return r.collect.paused ? 'paused' : 'live';
  if (r.status === 'collecting') return 'interrupted';
  if (r.collect.runStatus === 'cancelled') return 'cancelled';
  if (r.collect.runStatus === 'failed' && r.collect.errorCode !== null) return 'failed';
  return 'awaiting';
});

const collectMessage = computed(() => {
  const r = open.value;
  switch (collectState.value) {
    case 'live':
      return t.research.collectLive;
    case 'paused':
      return t.research.collectPaused;
    case 'interrupted':
      return t.research.collectInterrupted;
    case 'cancelled':
      return t.research.awaitingCancelled;
    case 'failed':
      return fill(t.research.awaitingFailed, {
        reason:
          r?.collect.errorCode === null || r?.collect.errorCode === undefined
            ? ''
            : (errorMessages[r.collect.errorCode] ?? r.collect.errorCode),
      });
    case 'awaiting':
      return t.research.awaitingBody;
    case 'reviewing':
      return t.research.reviewingBody;
    default:
      return '';
  }
});

function when(ms: number): string {
  return new Date(ms).toLocaleString('zh-TW', { hour12: false });
}

/** 一列候選的初讀那一行：判斷 ＋ 理由；還沒讀、讀失敗的照實說。 */
function digestLineOf(c: Candidate): string {
  if (c.relevance !== null) {
    const label = t.research.relevance[c.relevance];
    return c.relevanceWhy.length > 0 ? `${label} —— ${c.relevanceWhy}` : label;
  }
  if (c.digestCode !== null) {
    return fill(t.research.digestFailed, { reason: errorMessages[c.digestCode] ?? c.digestCode });
  }
  const acquired = c.acquisition === 'fetched' || c.acquisition === 'uploaded';
  if (!acquired || c.itemId === null) return '';
  return open.value?.collect.live === true ? t.research.digestQueued : t.research.digestPending;
}

function digestByOf(c: Candidate): string {
  if (c.digestedBy === null || c.digestedAt === null) return '';
  return fill(t.research.digestBy, {
    model: c.digestedBy,
    date: new Date(c.digestedAt).toLocaleDateString('zh-TW'),
  });
}

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
      </header>

      <!--
        命中那一行是**輸入主題那一刻**的事實（R1）。過了閘門一就不顯示：那時專題裡多了抓回來的幾份，
        「你已有的 10 份裡，1 份提到它」會是兩個不同時間的數字湊成的一句錯話（第一版就是那樣）。
      -->
      <p v-if="planning" class="hits">{{ hitsText }}</p>
      <ul v-if="open.hits.length > 0 && planning" class="hit-list">
        <li v-for="hit in open.hits" :key="hit.itemId">
          <span class="hit-title">{{ hit.title }}</span>
          <span class="excerpt muted">{{ hit.excerpt }}</span>
        </li>
      </ul>

      <div v-if="planning" class="two">
        <!--
          左：對話。每一輪寫得出是誰說的、哪個模型。**不寫金額**（2026-10-03 使用者決定）：
          Claude Code 回報的是等值價格，用訂閱的話不會真的扣這筆錢，寫在畫面上會被讀成「花掉了」。
        -->
        <div class="talk">
          <ul v-if="open.messages.length > 0" class="turns">
            <li v-for="m in open.messages" :key="m.id" :class="['turn', m.role]">
              <span class="who">{{ m.role === 'user' ? t.research.you : t.research.model }}</span>
              <span v-if="m.code !== null" class="failed">{{ t.research.failedTurn }}</span>
              <span v-else class="said">{{ m.content }}</span>
              <span v-if="m.role === 'model'" class="turn-meta muted">{{ m.model }}</span>
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

      <!-- 閘門一之後：蒐集（Stage 20）。照方向分組，每一列候選說得出它現在是哪一種、為什麼。 -->
      <div v-else class="collect">
        <template v-if="open.status === 'building'">
          <h3>
            {{ fill(t.research.buildProgress, { done: open.build.done, total: open.build.total }) }}
          </h3>
          <button v-if="open.build.live" :disabled="busy !== ''" @click="control('cancel')">
            {{ t.runs.cancel }}
          </button>
          <p v-else class="hint">{{ t.research.buildStopped }}</p>
        </template>
        <h3 v-if="open.status !== 'building'">
          {{ collectState === 'reviewing' ? t.research.reviewingTitle : t.research.collectTitle }}
        </h3>
        <p
          v-if="open.status !== 'building'"
          :class="[
            'callout',
            collectState === 'awaiting' || collectState === 'reviewing' ? '' : 'pending',
          ]"
        >
          {{ collectMessage }}
        </p>

        <!-- 作業活著：暫停／取消，以及節流（**只在真的在抓的時候出現**，ui-workflows §4）。 -->
        <div v-if="open.collect.live" class="actions">
          <button class="small" @click="control(open.collect.paused ? 'resume' : 'pause')">
            {{ open.collect.paused ? t.runControl.resume : t.runControl.pause }}
          </button>
          <button class="small" @click="control('cancel')">{{ t.runs.cancel }}</button>
          <span v-if="throttleNow" class="hint now">
            {{ fill(t.runs.throttleNow, { host: throttleNow.host, ms: throttleNow.ms }) }}
          </span>
        </div>

        <!-- 還有沒做完的：繼續蒐集（R13）。**搜尋那一段會花錢**，按鈕旁邊先說。 -->
        <template v-if="open.collect.mayResume">
          <p class="hint">{{ workLeftText }}</p>
          <div class="actions">
            <button :disabled="busy !== ''" @click="resumeCollecting">
              {{ t.research.resume }}
            </button>
            <span class="hint">{{ resumeText }}</span>
          </div>
        </template>

        <ol class="collect-directions">
          <li v-for="d in adopted" :key="d.id" class="collect-direction">
            <div class="direction-line">
              <strong>{{ d.title }}</strong>
              <span v-if="d.origin === 'human'" class="badge human">{{ t.research.edited }}</span>
              <span class="muted small">{{ directionState(d) }}</span>
            </div>
            <p v-if="d.searchState === 'done' && d.searchCode !== null" class="muted small notice">
              {{ errorMessages[d.searchCode] ?? d.searchCode }}
            </p>
            <p v-if="d.tally.found > rowsOf(d).length" class="muted small">
              {{ fill(t.research.sharedElsewhere, { n: d.tally.found - rowsOf(d).length }) }}
            </p>

            <ul v-if="rowsOf(d).length > 0" class="candidates">
              <li v-for="c in rowsOf(d)" :key="c.id" :class="['candidate', c.acquisition]">
                <div class="cand-head">
                  <span :class="['badge', 'acq', c.acquisition]">
                    {{ t.research.acquisition[c.acquisition] }}
                  </span>
                  <button
                    v-if="
                      c.itemId !== null &&
                      (c.acquisition === 'fetched' || c.acquisition === 'uploaded')
                    "
                    class="link cand-title"
                    :title="t.research.openInReader"
                    @click="readItem(c.itemId)"
                  >
                    {{ c.title.length > 0 ? c.title : c.url }}
                  </button>
                  <a
                    v-else
                    class="cand-title"
                    :href="c.url"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {{ c.title.length > 0 ? c.title : c.url }}
                  </a>
                  <span class="muted small host">{{ c.host }}</span>
                </div>
                <template v-if="open.status === 'reviewing'">
                  <p class="hint">{{ decisionLabel(c) }}</p>
                  <div class="actions">
                    <label
                      v-for="choice in ['include', 'reference', 'discard'] as const"
                      :key="choice"
                    >
                      <input
                        type="radio"
                        :name="`decision-${c.id}`"
                        :checked="c.effectiveDecision === choice"
                        :disabled="
                          busy !== '' || busyRow !== null || (choice === 'include' && !c.hasBody)
                        "
                        @change="decide(c, choice)"
                      />
                      {{
                        choice === 'include'
                          ? t.research.decisionInclude
                          : choice === 'discard'
                            ? t.research.decisionDiscard
                            : c.hasBody
                              ? t.research.decisionKeep
                              : t.research.decisionReference
                      }}
                    </label>
                    <button
                      v-if="c.decision !== null"
                      class="quiet small"
                      :disabled="busy !== '' || busyRow !== null"
                      @click="decide(c, null)"
                    >
                      {{ t.research.decisionReset }}
                    </button>
                  </div>
                  <fieldset v-if="c.effectiveDecision === 'reference' && !c.hasBody">
                    <legend>{{ t.research.citedBy }}</legend>
                    <label
                      v-for="source in open.candidates.filter(
                        (entry) =>
                          entry.itemId !== null &&
                          entry.itemId !== c.itemId &&
                          (entry.acquisition === 'fetched' || entry.acquisition === 'uploaded'),
                      )"
                      :key="source.id"
                    >
                      <input
                        type="checkbox"
                        :checked="c.citedBy.includes(source.id)"
                        :disabled="busy !== '' || busyRow !== null"
                        @change="cite(c, source.id, $event)"
                      />
                      {{ source.title }}
                    </label>
                  </fieldset>
                </template>
                <p v-if="c.buildCode" class="hint">
                  {{ errorMessages[c.buildCode] ?? c.buildCode }}
                </p>
                <!-- 初讀（Stage 21）：繁中標題是衍生物，原文在上面那一行（R15）。 -->
                <p
                  v-if="c.titleZh !== null && c.titleZh !== c.title"
                  class="small zh-title"
                  :title="digestByOf(c)"
                >
                  {{ c.titleZh }}
                </p>
                <p
                  v-if="digestLineOf(c).length > 0"
                  :class="['small', 'digest', c.relevance ?? 'none']"
                >
                  {{ digestLineOf(c) }}
                </p>
                <p v-if="c.why.length > 0" class="muted small why">{{ c.why }}</p>
                <p class="muted small meta">
                  <span v-if="bibOf(c).length > 0">{{ bibOf(c) }} · </span>
                  {{ t.research.expectedLabel }}：{{ t.research.expected[c.expectedAccess] }}
                  <template v-if="c.directionIds.length > 1">
                    · {{ fill(t.research.alsoFoundBy, { n: c.directionIds.length - 1 }) }}
                  </template>
                </p>
                <p
                  v-if="noteOf(c).length > 0"
                  :class="['small', 'note', noteIsReason(c) ? 'reason' : 'muted']"
                >
                  {{ noteOf(c) }}
                </p>

                <!-- 這一列按得下去的動作（伺服器說了算，見檔頭）。 -->
                <div
                  v-if="c.actions.upload || c.actions.unavailable || c.actions.reopen"
                  class="cand-actions"
                >
                  <label v-if="c.actions.upload" class="btn small" :title="t.research.uploadHint">
                    {{ busyRow === c.id ? t.research.uploading : t.research.upload }}
                    <input
                      type="file"
                      hidden
                      :disabled="busyRow !== null"
                      @change="uploadFor(c, $event)"
                    />
                  </label>
                  <button
                    v-if="c.actions.unavailable && reasonOpen !== c.id"
                    class="small"
                    :disabled="busyRow !== null"
                    @click="reasonOpen = c.id"
                  >
                    {{ t.research.unavailableOpen }}
                  </button>
                  <template v-if="c.actions.unavailable && reasonOpen === c.id">
                    <select
                      :value="reasonDraft[c.id] ?? 'paywall'"
                      :aria-label="t.research.unavailableLabel"
                      @change="
                        reasonDraft[c.id] = ($event.target as HTMLSelectElement)
                          .value as UnavailableReason
                      "
                    >
                      <option v-for="r in UNAVAILABLE_REASONS" :key="r" :value="r">
                        {{ t.research.unavailableReasons[r] }}
                      </option>
                    </select>
                    <input
                      v-if="(reasonDraft[c.id] ?? 'paywall') === 'other'"
                      v-model="noteDraft[c.id]"
                      type="text"
                      class="note-input"
                      :placeholder="t.research.notePlaceholder"
                    />
                    <button
                      class="small"
                      :disabled="busyRow !== null || !mayMark(c)"
                      @click="markUnavailable(c)"
                    >
                      {{ t.research.markUnavailable }}
                    </button>
                    <button class="quiet small" @click="reasonOpen = null">
                      {{ t.research.unavailableClose }}
                    </button>
                  </template>
                  <button
                    v-if="c.actions.reopen"
                    class="quiet small"
                    :disabled="busyRow !== null"
                    @click="reopen(c)"
                  >
                    {{ t.research.reopen }}
                  </button>
                </div>
              </li>
            </ul>
          </li>
        </ol>

        <ol v-if="dropped.length > 0" class="frozen-list">
          <li v-for="d in dropped" :key="d.id" class="dropped">
            {{ d.title }}
            <span class="badge">{{ t.research.frozenNotAdopted }}</span>
          </li>
        </ol>
      </div>

      <footer class="gate">
        <template v-if="planning">
          <p class="hint">{{ t.research.gateOneHint }}</p>
          <p v-if="draft.length > 0" class="hint">
            {{ fill(t.research.gateOneNext, { n: draft.length }) }}
            {{
              fill(t.research.gateOneRuns, {
                find: costLabelOf(open.findService),
                digest: costLabelOf(open.digestService),
              })
            }}
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
        <template v-else-if="open.status === 'reviewing' || open.status === 'building'">
          <template v-if="open.status === 'reviewing'">
            <p class="hint">{{ t.research.gapHint }}</p>
            <p class="hint">{{ costLabelOf(open.service) }}</p>
            <button :disabled="busy !== '' || busyRow !== null" @click="assessGap">
              {{ t.research.gap }}
            </button>
          </template>
          <p class="hint">{{ costLabelOf(open.extractService) }}</p>
          <div class="actions">
            <button
              v-if="open.status === 'reviewing' || open.build.mayResume"
              class="primary"
              :disabled="busy !== '' || busyRow !== null"
              @click="build()"
            >
              {{ open.status === 'reviewing' ? t.research.build : t.research.resumeBuild }}
            </button>
            <button v-if="open.build.mayFinish" :disabled="busy !== ''" @click="build(true)">
              {{ t.research.finishBuild }}
            </button>
          </div>
        </template>
        <template v-else-if="collectState !== 'reviewing'">
          <p class="hint">
            {{ open.collect.live ? t.research.gateTwoLive : t.research.gateTwoHint }}
          </p>
          <div class="actions">
            <button
              class="primary"
              :disabled="busy !== '' || !open.collect.mayFinish"
              @click="gateTwo"
            >
              {{ t.research.gateTwo }}
            </button>
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

    <!-- 已經結束的那一次（從「歷次研究」點開）：唯讀，沒有任何會動資料的按鈕。 -->
    <section v-if="finished !== null" class="finished">
      <header class="live-head">
        <strong class="topic">{{ finished.topic }}</strong>
        <span class="badge">{{ t.research.status[finished.status] }}</span>
        <button class="quiet small" type="button" @click="current = null">
          {{ t.research.finishedClose }}
        </button>
      </header>
      <template v-if="finished.directions.length > 0">
        <p v-if="finished.status === 'done'" class="callout">{{ finishedSummary }}</p>
        <div v-if="finished.build.focusItemId !== null" class="actions">
          <button type="button" @click="showFinishedOnGraph">
            {{ t.research.finishedShowOnGraph }}
          </button>
        </div>
        <ol class="collect-directions">
          <li
            v-for="d in finished.directions.filter((entry) => entry.adopted)"
            :key="d.id"
            class="collect-direction"
          >
            <div class="direction-line">
              <strong>{{ d.title }}</strong>
              <span v-if="d.origin === 'human'" class="badge human">{{ t.research.edited }}</span>
              <span class="muted small">{{ fill(t.research.reviewTally, { ...d.tally }) }}</span>
            </div>
            <ul v-if="finishedRowsOf(d).length > 0" class="candidates">
              <li v-for="c in finishedRowsOf(d)" :key="c.id" :class="['candidate', c.acquisition]">
                <div class="cand-head">
                  <span :class="['badge', 'acq', c.acquisition]">
                    {{ t.research.acquisition[c.acquisition] }}
                  </span>
                  <button
                    v-if="
                      c.itemId !== null &&
                      (c.acquisition === 'fetched' || c.acquisition === 'uploaded')
                    "
                    class="link cand-title"
                    :title="t.research.openInReader"
                    @click="readItem(c.itemId)"
                  >
                    {{ c.title.length > 0 ? c.title : c.url }}
                  </button>
                  <a
                    v-else
                    class="cand-title"
                    :href="c.url"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {{ c.title.length > 0 ? c.title : c.url }}
                  </a>
                  <span class="muted small host">{{ c.host }}</span>
                </div>
                <p class="hint">
                  {{ fill(t.research.finalDecision, { decision: finalLabelOf(c) }) }}
                  <template v-if="c.decision !== null"> · {{ t.research.decisionEdited }}</template>
                </p>
                <p v-if="c.buildCode" class="hint">
                  {{ errorMessages[c.buildCode] ?? c.buildCode }}
                </p>
                <p v-if="c.titleZh !== null && c.titleZh !== c.title" class="small zh-title">
                  {{ c.titleZh }}
                </p>
                <p
                  v-if="digestLineOf(c).length > 0"
                  :class="['small', 'digest', c.relevance ?? 'none']"
                >
                  {{ digestLineOf(c) }}
                </p>
              </li>
            </ul>
          </li>
        </ol>
      </template>
      <!-- 規劃到一半就放棄：方向還沒落成表，列當時的規劃。 -->
      <template v-else>
        <p class="hint">{{ t.research.finishedPlanOnly }}</p>
        <ol class="finished-plan">
          <li v-for="(d, i) in finished.plan.directions" :key="i">{{ d.title }}</li>
        </ol>
      </template>
    </section>

    <section v-if="current?.gap" class="gap-assessment">
      <h3>{{ t.research.gapOpinion }}</h3>
      <p class="gap-opinion">{{ current.gap.opinion }}</p>
      <p class="muted small">{{ current.gap.model }} · {{ when(current.gap.at) }}</p>
    </section>

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
      <section v-if="deletion !== null" aria-labelledby="research-deletion-title">
        <h3 id="research-deletion-title">
          {{ fill(t.research.removeTitle, { topic: deletion.topic ?? '' }) }}
        </h3>
        <h4>{{ t.research.willDelete }}</h4>
        <ul>
          <li v-for="kind in deletion.willDelete" :key="kind">
            {{ t.research.deletionItems[kind] }}
          </li>
        </ul>
        <h4>{{ t.research.willKeep }}</h4>
        <ul>
          <li v-for="kind in deletion.willKeep" :key="kind">
            {{ t.research.deletionItems[kind] }}
          </li>
        </ul>
        <button :disabled="busy !== ''" @click="confirmRemove">
          {{ t.research.removeConfirm }}
        </button>
        <button :disabled="busy !== ''" @click="deletion = null">
          {{ t.research.removeCancel }}
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.gap-opinion {
  white-space: pre-wrap;
}

/* 已經結束的那一次：跟上面的輸入框隔開，看得出是另一塊。 */
.finished {
  margin-top: var(--s4);
  padding-top: var(--s3);
  border-top: 1px solid var(--line-subtle);
}
.finished-plan {
  margin: var(--s2) 0 0;
  padding-left: var(--s5);
}

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

/* ── 蒐集 ── */
.collect .callout {
  margin-bottom: var(--s3);
}
.now {
  color: var(--edge-pending);
}
.collect-directions {
  margin: var(--s3) 0;
  padding-left: var(--s4);
  display: grid;
  gap: var(--s4);
}
.direction-line {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  flex-wrap: wrap;
}
.notice {
  margin: var(--s1) 0 0;
}
.candidates {
  list-style: none;
  margin: var(--s2) 0 0;
  padding: 0;
  display: grid;
  gap: var(--s2);
}
.candidate {
  padding: var(--s2);
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  display: grid;
  gap: 2px;
  min-width: 0;
}
/* 要你拿的那幾列要一眼找得到 —— 它們是這一段唯一要你動手的東西。 */
.candidate.needs-user {
  border-color: var(--edge-pending);
}
.cand-head {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  flex-wrap: wrap;
  min-width: 0;
}
/* 標題可能是一整串網址 —— 讓它斷行，不要把整張卡撐寬。 */
.cand-title {
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: left;
  font-weight: 400;
}
.host {
  overflow-wrap: anywhere;
}
.why,
.meta,
.note {
  margin: 0;
  overflow-wrap: anywhere;
}
.note.reason {
  color: var(--text-secondary);
}
.cand-actions {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex-wrap: wrap;
  margin-top: var(--s1);
}
.note-input {
  flex: 1 1 16ch;
  min-width: 0;
}
/* 取得狀態的徽章。**狀態一律是文字，顏色只是輔助**（ADR-0018，同作業紀錄那一頁）。 */
.badge.acq.fetched,
.badge.acq.uploaded {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.badge.acq.needs-user,
.badge.acq.fetching {
  border-color: var(--edge-pending);
  color: var(--edge-pending);
}
.badge.acq.unavailable {
  border-color: var(--line-muted);
  color: var(--text-tertiary);
}
/* 初讀（Stage 21）。**判斷一律是文字**（「初讀：有關」），顏色只是輔助 —— 同上面的徽章（ADR-0018）。 */
.zh-title,
.digest {
  margin: 0;
  overflow-wrap: anywhere;
}
.zh-title {
  color: var(--text-secondary);
}
.digest.yes {
  color: var(--ui-success);
}
.digest.unsure {
  color: var(--edge-pending);
}
.digest.no,
.digest.none {
  color: var(--text-tertiary);
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

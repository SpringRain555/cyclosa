<script setup lang="ts">
/**
 * 設定（ui-workflows §5）。
 *
 * ## 模型那一頁：「模型分工」＋「模型服務」（v0.24.0 的形狀，ADR-0032；v0.24.2 的名字）
 *
 * 「模型分工」一張表，四列：每一個會用到模型的任務各自說「交給哪個服務上的哪個模型」，
 * 右邊是它現在跑不跑得動。「模型服務」在底下各設定一次（Claude Code、Ollama、OpenAI 相容 API），
 * 每一塊各自框起來，名字底下一行說它在哪裡跑、花不花錢。
 *
 * v0.10.6–v0.23.0 的版本是「三個角色各一格 ＋ 一張逐任務覆寫表」——
 * 使用者第一次真的用（2026-09-18）問「可調用模型與各任務模型是不是重複」，
 * 而切到線上端點之後滿頁都是 Ollama 的舊值。兩個問題的根都是「主鍵是角色」：
 * 使用者要決定的是每一件事跑哪裡，不是每一個角色連哪裡。
 * 2026-09-19 使用者再看一次：三個區塊分不清、「連線」「連線並列出模型」用詞不準、
 * 儲存與測試要放在表的右上角 —— 所以有了下面這兩顆。
 *
 * ## 兩顆按鈕：「儲存並檢查」不花錢，「儲存並測試」會
 *
 * 打開這一頁不該產生費用，所以它只讀 `/api/providers`
 * （CLI 只跑 `--version`、HTTP 連線只列模型清單）。
 * - 每一塊「模型服務」右上角的「**儲存並檢查**」：先存這一塊，再看連不連得上、有哪些模型
 *   （列出來的模型就是上面那張表的下拉選單）。位址或金鑰變數一改，舊清單就作廢，模型欄退回手打。
 * - 「模型分工」右上角的「**儲存並測試**」：先存這一頁，再對每一個設好的任務**真的打一次**，
 *   逐列寫結果。CLI 與線上服務會花錢，按鈕底下先講。找來源走 OpenAI 相容 API 的話，
 *   測的是「會不會上網搜尋」（ADR-0034）。
 *
 * ## 改了就存，沒有儲存鈕（v0.24.1）
 *
 * v0.24.0 的儲存鈕在整頁最下面，2026-09-19 使用者說「調整完容易忘記按」—— 而忘了按的後果
 * 是安靜的：右邊那一欄的狀態是存檔那一份的，畫面看起來設好了，跑起來卻是舊的。
 * 這一頁的每一個改動都是**可以原樣改回去的**（換嵌入模型也是：向量照模型分開存，
 * 換回來舊的就能用），沒有一個需要「先想好再一起送出」—— 所以選了就存，
 * 文字欄在離開那一格（或按 Enter）時存，不是每打一個字存一次。
 * 存的狀態寫在這一頁**最上面、捲動時跟著走**的那一行，失敗要說原因。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  api,
  type ApiError,
  type BrowseReport,
  type ChatTask,
  type ConnectionKind,
  type ConnectionStatus,
  type HttpConnection,
  type JsonModeReport,
  type ModelTask,
  type ProvidersConfig,
  type ProvidersPayload,
  type TaskRow,
  type TaskSetting,
} from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';
import SourcesPanel from '../components/SourcesPanel.vue';
import StatusGuide from '../components/StatusGuide.vue';
import StoragePanel from '../components/StoragePanel.vue';
import { useModelStateStore } from '../stores/model-state-store';

const payload = ref<ProvidersPayload | null>(null);
const error = ref<ApiError | null>(null);
/** 頂列那一顆點：這一頁讀到或存完一份，就直接交給它（v0.24.1）。 */
const modelStore = useModelStateStore();

const tab = ref<'models' | 'sources' | 'guide' | 'storage'>('models');

// ── 表單：設定的可編輯複本 ──────────────────────────────
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
const cliCommand = ref('');
const cliArgs = ref<string[]>([]);
const ollamaUrl = ref(OLLAMA_DEFAULT_URL);
const openaiUrl = ref('');
/** **變數的名字，不是金鑰。** 金鑰不進任何一個檔（2026-09-08 的決定）。 */
const openaiKeyEnv = ref('');
const TASK_ORDER: readonly ModelTask[] = [
  'plan',
  'find-sources',
  'digest',
  'angles',
  'extract',
  'embed',
];
function emptyTasks(): Record<ModelTask, TaskSetting> {
  return {
    plan: { via: 'cli', model: '' },
    'find-sources': { via: 'cli', model: '' },
    digest: { via: 'ollama', model: '' },
    angles: { via: 'ollama', model: '' },
    extract: { via: 'ollama', model: '' },
    embed: { via: 'ollama', model: '' },
  };
}
const tasks = ref<Record<ModelTask, TaskSetting>>(emptyTasks());
/**
 * 留下每一次模型呼叫的紀錄。**預設關著。**
 * 開關在這裡而不是在設定檔裡，理由是時機：
 * **遇到一個壞掉的抽取結果的當下，才是唯一能把它重現下來的時機。**
 */
const logModelCalls = ref(false);

/**
 * 伺服器收不收這個名字。**跟 `providers/config.ts` 的 `ENV_NAME` 是同一條**
 * （`tests/guards/api-key-env-name.test.ts` 逼兩邊一致）。
 *
 * **在這裡檢查是因為不合格的名字會被安靜地丟掉**：`apiKeyEnvOf` 回 `null`，
 * 存檔成功、畫面重新載入之後那一格變空的 —— 使用者看到的是「我打的字不見了」。
 * 2026-09-18 真的踩到：一個叫 `OPENAI_API_KEY_v1` 的變數（結尾是小寫）。
 */
const apiKeyEnvBad = computed(() => {
  const name = openaiKeyEnv.value.trim();
  return name.length > 0 && !/^[A-Z][A-Z0-9_]{1,63}$/.test(name);
});
// 小寫直接轉大寫。Windows 的環境變數不分大小寫，所以 `OPENAI_API_KEY_v1` 與
// `OPENAI_API_KEY_V1` 讀到的是同一個；與其擋下來叫使用者重打，不如替他轉。
// 減號、空白之類的還是會被上面那條擋 —— 那才是「有人把金鑰貼進來」的訊號。
watch(openaiKeyEnv, (value) => {
  const upper = value.toUpperCase();
  if (upper !== value) openaiKeyEnv.value = upper;
});

// ── 建議值 ─────────────────────────────────────────────
/**
 * 量測選出來的建議值（`docs/research/`，2026-09-09）。
 * **顯示成一顆可以按的建議，不自己填進去** —— 換嵌入模型的代價比另外兩個大，
 * 所以它要是使用者按下去的，不是我們替他決定的。
 *
 * **這幾個字串在 src/infrastructure/providers/config.ts 也有一份。**
 * web 與 server 是兩份建置，所以只能各抄一份 ——
 * tests/guards/recommended-models.test.ts 釘著它們一致。
 */
const RECOMMENDED_EMBED = 'hf.co/mykor/granite-embedding-311m-multilingual-r2-GGUF:BF16';
const RECOMMENDED_CHAT = 'granite4.2:8b';
const RECOMMENDED_TASK: Record<ChatTask, string> = {
  angles: 'granite4.2:8b',
  extract: RECOMMENDED_CHAT,
  digest: RECOMMENDED_CHAT,
};
/**
 * 表格那一欄用的建議值，**每個任務都有一格**。
 * `find-sources` 是空字串 —— **那不是「沒有建議」，是「建議不要帶」**：
 * agent 的模型由 CLI 自己的設定決定，而我們沒有量過在那一邊換模型的效果。
 */
const RECOMMENDED_TASK_ALL: Record<ModelTask, string> = {
  // 規劃對話跟找來源同一個理由：**沒有量過在這個任務上換模型的效果**，
  // 所以不給建議值 —— 一個沒有量測背書的建議比沒有建議糟。
  plan: '',
  'find-sources': '',
  ...RECOMMENDED_TASK,
  embed: RECOMMENDED_EMBED,
};
/** 建議值是在本機 Ollama 上量的 —— 走線上端點的任務不顯示（那是用一份沒量過的結果替它背書）。 */
function recommendationFor(task: ModelTask): string {
  const model = RECOMMENDED_TASK_ALL[task];
  if (model.length === 0 || tasks.value[task].via !== 'ollama') return '';
  return tasks.value[task].model === model ? '' : model;
}
function recommendWhy(task: ModelTask): string {
  const why = t.settings.taskRecommendWhy as Partial<Record<ModelTask, string>>;
  return why[task] ?? '';
}

// ── 連線的模型清單 ─────────────────────────────────────
type HttpKind = 'ollama' | 'openai';
interface Listed {
  readonly models: string[] | null;
  /** 列的時候用的位址與金鑰變數 —— 改了就是對另一條端點列的，清單作廢。 */
  readonly baseUrl: string;
  readonly apiKeyEnv: string | null;
}
const listed = ref<Record<HttpKind, Listed | null>>({ ollama: null, openai: null });

function connectionDraft(kind: HttpKind): HttpConnection {
  if (kind === 'ollama') return { baseUrl: ollamaUrl.value.trim(), apiKeyEnv: null };
  const key = openaiKeyEnv.value.trim();
  return { baseUrl: openaiUrl.value.trim(), apiKeyEnv: key.length === 0 ? null : key };
}
function isStale(kind: HttpKind): boolean {
  const l = listed.value[kind];
  if (l === null) return true;
  const c = connectionDraft(kind);
  return l.baseUrl !== c.baseUrl || l.apiKeyEnv !== c.apiKeyEnv;
}
/** 這條連線現在列得出來的模型；還沒列、或位址改了 → `null`，模型欄退回手打。 */
function modelsFor(kind: ConnectionKind): string[] | null {
  if (kind === 'cli') return null;
  if (isStale(kind)) return null;
  return listed.value[kind]?.models ?? null;
}

const checking = ref<ConnectionKind | null>(null);
const checkResult = ref<{ kind: ConnectionKind; text: string } | null>(null);

function nowText(): string {
  return new Date().toLocaleTimeString('zh-TW', { hour12: false });
}

/**
 * 「儲存並檢查」：先把這一塊存起來，再看它連不連得上、有哪些模型。**不花錢** ——
 * CLI 只跑 `--version`，HTTP 的兩種只列 `/models`。金鑰變數的名字不合格時擋在最前面：那時候不存，
 * 也就沒有東西可以檢查。
 */
async function checkConnection(kind: ConnectionKind): Promise<void> {
  checkResult.value = null;
  if (kind === 'openai' && apiKeyEnvBad.value) {
    checkResult.value = { kind, text: t.settings.checkHeld };
    return;
  }
  checking.value = kind;
  await flush();
  if (saveTone.value === 'failed') {
    checking.value = null;
    checkResult.value = { kind, text: saveStateText.value };
    return;
  }
  const time = nowText();
  if (kind === 'cli') {
    await refresh();
    checking.value = null;
    checkResult.value = {
      kind,
      text: fill(t.settings.checkedCli, { summary: connectionSummary('cli'), time }),
    };
    return;
  }
  const r = await api.listModels(kind, connectionDraft(kind));
  checking.value = null;
  if (!r.ok) {
    checkResult.value = { kind, text: errorMessages[r.error.code] ?? r.error.code };
    return;
  }
  listed.value[kind] = { models: r.data.models, ...connectionDraft(kind) };
  checkResult.value = {
    kind,
    text:
      r.data.models === null
        ? t.settings.listedNone
        : fill(t.settings.listedOk, { n: r.data.models.length, time }),
  };
}

// ── 讀與存 ─────────────────────────────────────────────
function fillFrom(data: ProvidersPayload): void {
  const c = data.config;
  cliCommand.value = c.connections.cli?.command ?? '';
  cliArgs.value = c.connections.cli?.args ?? [];
  ollamaUrl.value = c.connections.ollama.baseUrl;
  openaiUrl.value = c.connections.openai?.baseUrl ?? '';
  openaiKeyEnv.value = c.connections.openai?.apiKeyEnv ?? '';
  const next = emptyTasks();
  for (const task of TASK_ORDER) next[task] = { ...c.tasks[task] };
  tasks.value = next;
  logModelCalls.value = c.diagnostics.logModelCalls;
  listsFrom(data);
}

/**
 * 存檔那一份連線列出來的模型，就是下拉選單。**只動清單，不動表單** ——
 * 存檔回來的時候使用者可能已經在打下一格了，那時候用存檔那一份蓋掉表單，會吃掉剛打的字。
 * 清單記著它是對哪個位址列的，對不上現在表單上的位址就自動作廢（`isStale`）。
 */
function listsFrom(data: ProvidersPayload): void {
  const c = data.config;
  for (const kind of ['ollama', 'openai'] as const) {
    const status = data.connections.find((row) => row.kind === kind);
    const conn = kind === 'ollama' ? c.connections.ollama : c.connections.openai;
    listed.value[kind] =
      status === undefined || conn === null
        ? null
        : { models: status.models, baseUrl: conn.baseUrl, apiKeyEnv: conn.apiKeyEnv };
  }
}

async function load(): Promise<void> {
  const r = await api.providers();
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  payload.value = r.data;
  fillFrom(r.data);
  modelStore.setFrom(r.data);
}
onMounted(() => void load());

/**
 * 重新讀狀態（檢查或測試之後）。**不用存檔那一份蓋掉表單** —— 除非表單跟存檔一樣，
 * 那時候蓋等於沒蓋。讀回來的期間使用者可能又在打下一格。
 */
async function refresh(): Promise<void> {
  const r = await api.providers();
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  payload.value = r.data;
  modelStore.setFrom(r.data);
  if (dirty.value) listsFrom(r.data);
  else fillFrom(r.data);
}

function draftConfig(): ProvidersConfig {
  const key = openaiKeyEnv.value.trim();
  return {
    version: 2,
    connections: {
      cli:
        cliCommand.value.trim().length === 0
          ? null
          : { command: cliCommand.value.trim(), args: cliArgs.value },
      ollama: {
        baseUrl: ollamaUrl.value.trim().length === 0 ? OLLAMA_DEFAULT_URL : ollamaUrl.value.trim(),
        apiKeyEnv: null,
      },
      openai:
        openaiUrl.value.trim().length === 0
          ? null
          : { baseUrl: openaiUrl.value.trim(), apiKeyEnv: key.length === 0 ? null : key },
    },
    tasks: Object.fromEntries(
      TASK_ORDER.map((task) => [
        task,
        { via: tasks.value[task].via, model: tasks.value[task].model.trim() },
      ]),
    ) as Record<ModelTask, TaskSetting>,
    diagnostics: { logModelCalls: logModelCalls.value },
  };
}

/**
 * 表單跟存檔那一份不一樣。改了就存之後，這只在兩個時候成立：
 * 某一格還在打（文字欄離開那一格才存），或上一次沒存成。
 */
const dirty = computed(
  () =>
    payload.value !== null &&
    JSON.stringify(draftConfig()) !== JSON.stringify(payload.value.config),
);

// ── 改了就存（v0.24.1）─────────────────────────────────
/**
 * `held`：金鑰變數的名字不合格。**那時候不存** —— 伺服器會把不合格的名字當成沒設
 * （`apiKeyEnvOf` 回 `null`），存下去之後畫面重新載入，使用者打的字就不見了。
 */
type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'held';
const saveState = ref<SaveState>('idle');
const savedAt = ref(0);
let inflight: Promise<void> | null = null;
/** 存檔途中又改了別的：這一次存完再存一次最新的，不是同時送兩份。 */
let again = false;

async function saveLoop(): Promise<void> {
  do {
    again = false;
    if (apiKeyEnvBad.value) {
      saveState.value = 'held';
      return;
    }
    const sent = JSON.stringify(draftConfig());
    saveState.value = 'saving';
    const r = await api.saveProviders(JSON.parse(sent) as ProvidersConfig);
    if (!r.ok) {
      error.value = r.error;
      saveState.value = 'failed';
      return;
    }
    error.value = null;
    payload.value = r.data;
    modelStore.setFrom(r.data);
    // 存檔途中使用者又打了字：只更新狀態與模型清單，**不用存檔那一份蓋掉表單**。
    if (JSON.stringify(draftConfig()) === sent) fillFrom(r.data);
    else listsFrom(r.data);
    savedAt.value = Date.now();
    saveState.value = 'saved';
  } while (again);
}

/** 每一個改動之後叫它。**同一時間只有一次存檔在路上。** */
function autosave(): Promise<void> {
  if (inflight !== null) {
    again = true;
    return inflight;
  }
  inflight = saveLoop().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 按「儲存並測試」或「儲存並檢查」之前：還沒存的先存，測的才是畫面上這一份。 */
async function flush(): Promise<void> {
  if (inflight !== null) await inflight;
  if (dirty.value) await autosave();
}

// 還在打的那一格：離開這一頁也算「離開那一格」。
onBeforeUnmount(() => {
  if (dirty.value) void autosave();
});

const savedAtText = computed(() =>
  savedAt.value === 0 ? '' : new Date(savedAt.value).toLocaleTimeString('zh-TW', { hour12: false }),
);

/**
 * 最上面那一行。**順序就是優先順序**：正在存 → 不能存 → 沒存成 → 還在打 → 存好了 → 還沒動過。
 * 「還沒動過」那一句是在說這一頁的規則 —— 沒有儲存鈕，第一次來的人要知道為什麼。
 */
type SaveTone = 'saving' | 'held' | 'failed' | 'editing' | 'saved' | 'idle';
const saveTone = computed<SaveTone>(() => {
  if (saveState.value === 'saving') return 'saving';
  if (apiKeyEnvBad.value) return 'held';
  if (saveState.value === 'failed') return 'failed';
  if (dirty.value) return 'editing';
  if (saveState.value === 'saved') return 'saved';
  return 'idle';
});
const saveStateText = computed(() => {
  const a = t.settings.autosave;
  switch (saveTone.value) {
    case 'saving':
      return a.saving;
    case 'held':
      return a.held;
    case 'failed':
      return fill(a.failed, {
        reason: error.value === null ? '' : (errorMessages[error.value.code] ?? error.value.code),
      });
    case 'editing':
      return a.editing;
    case 'saved':
      return fill(a.saved, { time: savedAtText.value });
    default:
      return a.idle;
  }
});

// ── 任務那張表 ─────────────────────────────────────────
/** 每個任務可以走哪些服務 —— 跟 server 的 `viaOptionsOf` 同一條規則（角色推出來的）。 */
function viaOptions(task: ModelTask): readonly ConnectionKind[] {
  if (task === 'embed') return ['ollama'];
  if (task === 'find-sources') return ['cli', 'openai'];
  // 規劃對話三個服務都可以，而且能力不同（ADR-0033 D5）：前兩個邊查邊談，Ollama 只能談。
  if (task === 'plan') return ['cli', 'openai', 'ollama'];
  return ['ollama', 'openai'];
}
/** 只有一種可選的任務，那一格要說為什麼。 */
function viaFixedText(task: ModelTask): string {
  return (t.settings.viaFixed as Partial<Record<ModelTask, string>>)[task] ?? '';
}
function setVia(task: ModelTask, via: ConnectionKind): void {
  if (tasks.value[task].via === via) return;
  // 模型名跟著服務走：Ollama 的模型名在 OpenAI 相容 API 上是一個不存在的模型。
  tasks.value[task] = { via, model: '' };
  void autosave();
}
/**
 * 換模型。下拉選單與「建議值」按下去就存；手打的那一格每打一個字進來一次（`save` 是 false），
 * 離開那一格才存。
 */
function setModelOf(task: ModelTask, model: string, save = true): void {
  tasks.value[task] = { ...tasks.value[task], model };
  if (save) void autosave();
}

/** 存檔那一份裡這個任務的狀態。 */
function rowOf(task: ModelTask): TaskRow | null {
  return payload.value?.tasks.find((row) => row.task === task) ?? null;
}
function connectionOf(kind: ConnectionKind): ConnectionStatus | null {
  return payload.value?.connections.find((row) => row.kind === kind) ?? null;
}
/** 狀態點的形狀：實心＝可以用、空心＝還沒設定、虛線＝連不上或配不上（跟頂列同一套）。 */
function dotOf(row: TaskRow | null): 'ready' | 'none' | 'problem' {
  if (row === null || row.state === 'not-configured') return 'none';
  return row.ok ? 'ready' : 'problem';
}
function missingText(row: TaskRow): string {
  if (row.missing.length === 0) return '';
  const names = row.missing.map(
    (f) => t.settings.capabilityNames[f as keyof typeof t.settings.capabilityNames] ?? f,
  );
  return fill(t.settings.missing, { flags: names.join('、') });
}
/**
 * 「格式保證」那一行。**量的時間一定要跟著** —— 一句沒有日期的量測結果，
 * 會在對方升版之後變成假話，而這個專案自己就寫過一句那樣的話。
 */
function jsonModeText(report: JsonModeReport | null): string {
  if (report === null) return '';
  if (report.mode === 'schema' && report.checkedAt === null) return t.settings.jsonModeNative;
  // 走的是哪一種協定要跟著寫：使用者指定了 Responses API（ADR-0034）。
  const proto = report.protocol === null ? '' : ` · ${t.settings.protocolName[report.protocol]}`;
  const text = `${t.settings.jsonMode[report.mode]}${proto}`;
  if (report.checkedAt === null) return text;
  const date = new Date(report.checkedAt).toLocaleString('zh-TW', { hour12: false });
  return `${text}（${fill(t.settings.jsonCheckedAt, { date })}）`;
}
/**
 * 「上網搜尋」那一行。CLI 的 `checkedAt` 是 null ＝ 參數保證的；OpenAI 相容 API 的是量的 ——
 * 量出不會的時候把原因帶出來（那句話說的是這個端點怎麼回的）。
 */
function browseText(report: BrowseReport): string {
  const b = t.settings.browse;
  if (report.state === 'unchecked') return b.unchecked;
  // **宣告的有兩種**：CLI 是「一定會」，本機 Ollama 是「一定不會」。
  // 只看 checkedAt 的話，後者會顯示成「由參數保證（--tools WebSearch）」——
  // 一句在講另一條服務的話。
  if (report.checkedAt === null) return report.state === 'yes' ? b.declared : b.declaredNo;
  const date = new Date(report.checkedAt).toLocaleString('zh-TW', { hour12: false });
  const base = report.state === 'yes' ? b.yes : `${b.no}：${report.detail}`;
  return `${base}（${fill(t.settings.jsonCheckedAt, { date })}）`;
}
function contextText(row: TaskRow): string {
  const n = row.capabilities.context_tokens;
  // **0 是「不知道」不是「只有 0 個」** —— 兩者的訊息不一樣
  return n > 0
    ? fill(t.settings.contextTokens, { n: n.toLocaleString('en-US') })
    : t.settings.contextUnknown;
}
const testing = ref<{ done: number; total: number } | null>(null);
const testResults = ref<Partial<Record<ModelTask, string>>>({});
const testSummary = ref('');

/**
 * 「儲存並測試」：先存這一頁，再對每一個設好的任務**真的打一次**，逐列寫結果。
 * **一個接一個**，不並行 —— 本機 Ollama 一次只常駐一個模型，四個同時打會互相把對方擠出去。
 * 還沒設定的任務略過（那一列寫「略過」，不是失敗）。
 */
async function testAll(): Promise<void> {
  testResults.value = {};
  testSummary.value = '';
  // 測的是存檔那一份 —— 還在打的那一格先存，不然測到的是上一版。最上面那一行會說存了沒。
  await flush();
  if (saveTone.value === 'failed' || saveTone.value === 'held') return;
  const targets = TASK_ORDER.filter((task) => rowOf(task)?.state !== 'not-configured');
  testing.value = { done: 0, total: targets.length };
  let okCount = 0;
  for (const task of TASK_ORDER) {
    if (!targets.includes(task)) {
      testResults.value[task] = t.settings.testSkipped;
      continue;
    }
    const r = await api.testProvider(task);
    if (!r.ok) {
      testResults.value[task] = errorMessages[r.error.code] ?? r.error.code;
    } else {
      const outcome = r.data.ok
        ? fill(t.settings.testOk, { ms: r.data.elapsedMs })
        : `${t.settings.testFailed}：${errorMessages[r.data.code ?? ''] ?? String(r.data.code)}`;
      // 線上端點按這顆會重量一次格式支援與搜尋 —— 量到什麼要當場說出來，不是等重新整理。
      const measured =
        r.data.jsonMode !== null && r.data.jsonMode.checkedAt !== null
          ? ` ${fill(t.settings.testJsonMode, { mode: jsonModeText(r.data.jsonMode) })}`
          : '';
      const browse =
        r.data.browse !== null
          ? ` ${fill(t.settings.testBrowse, { state: browseText(r.data.browse) })}`
          : '';
      testResults.value[task] = `${outcome}${measured}${browse}`;
      if (r.data.ok) okCount++;
    }
    testing.value = { done: testing.value.done + 1, total: targets.length };
  }
  // 量到的格式保證與搜尋要反映在狀態欄 —— 先更新，再把「做完了」那一句放上去。
  await refresh();
  testing.value = null;
  testSummary.value = fill(t.settings.testAllDone, {
    ok: okCount,
    total: targets.length,
    time: nowText(),
  });
}

// ── 連線那一區 ─────────────────────────────────────────
function connectionSummary(kind: ConnectionKind): string {
  const c = connectionOf(kind);
  if (c === null) return '';
  if (kind === 'cli') {
    if (c.state === 'ready') return `${t.settings.cliFound}${c.version ? ` · ${c.version}` : ''}`;
    if (c.state === 'unreachable') {
      return `${t.settings.connState.unreachable}${c.detail ? ` · ${c.detail}` : ''}`;
    }
    return t.settings.connState['not-configured'];
  }
  if (c.state === 'ready') {
    const n = c.models?.length ?? 0;
    return `${t.settings.connState.ready} · ${fill(t.settings.modelCount, { n })}`;
  }
  return t.settings.connState[c.state];
}
</script>

<template>
  <!--
    **捲動的是外層，寬度是內層**（base.css）。四個分頁同一個寬（960）——
    2026-09-11 之前四個分頁四種寬，而「同一個 app 的兩頁對寬螢幕怎麼辦給了不同答案」
    不是風格，是漏掉。寬畫面上分頁列直排在左邊（Primer／GitHub 設定頁的形狀），窄則回到上方。
  -->
  <main class="scroll">
    <div class="page wide settings-page">
      <h1>{{ t.settings.title }}</h1>

      <div class="layout">
        <nav class="tabs side">
          <button :class="{ on: tab === 'models' }" @click="tab = 'models'">
            {{ t.settings.tabs.models }}
          </button>
          <button :class="{ on: tab === 'sources' }" @click="tab = 'sources'">
            {{ t.settings.tabs.sources }}
          </button>
          <!--
            **狀態說明放在設定裡，不是圖上的第二顆按鈕。**
            圖上那一欄回答「我看到的這條線是什麼」（要即時、要窄），
            這一頁回答「這張圖總共用了哪些記號」（要完整）。
          -->
          <button :class="{ on: tab === 'guide' }" @click="tab = 'guide'">
            {{ t.settings.tabs.guide }}
          </button>
          <!--
            **資料位置。** 第一次啟動不再問「資料要放哪」，
            所以這一頁存在的第一個理由是**告訴使用者它在哪**。
          -->
          <button :class="{ on: tab === 'storage' }" @click="tab = 'storage'">
            {{ t.settings.tabs.storage }}
          </button>
        </nav>

        <div class="content">
          <SourcesPanel v-if="tab === 'sources'" />
          <StatusGuide v-else-if="tab === 'guide'" />
          <StoragePanel v-else-if="tab === 'storage'" />

          <template v-else>
            <!--
              **改了就存（v0.24.1），存的狀態在最上面、捲動時跟著走。**
              v0.24.0 的儲存鈕在整頁最底下，使用者調整完就忘了按 —— 而忘了按是安靜的。
            -->
            <p :class="['save-state', saveTone]" role="status" aria-live="polite">
              <span class="save-dot" aria-hidden="true"></span>
              <span class="save-text">{{ saveStateText }}</span>
              <button v-if="saveTone === 'failed'" class="small" type="button" @click="autosave()">
                {{ t.settings.autosave.retry }}
              </button>
            </p>
            <ErrorPanel v-if="error" :error="error" />

            <!-- ── 段落一：模型分工 ── -->
            <section class="card">
              <!--
                **「儲存並測試」在表的右上角**（2026-09-19 使用者指定的位置）：先存這一頁，
                再對每一個設好的任務真的打一次。會不會花錢寫在標題底下那一句，按之前就看得到。
              -->
              <header class="card-head">
                <h2>{{ t.settings.sectionTasks }}</h2>
                <div class="card-action">
                  <span v-if="testSummary" class="hint">{{ testSummary }}</span>
                  <button
                    class="primary"
                    type="button"
                    :disabled="testing !== null || saveTone === 'saving'"
                    @click="testAll()"
                  >
                    {{ testing ? fill(t.settings.testAllBusy, testing) : t.settings.testAll }}
                  </button>
                </div>
              </header>
              <p class="card-what">
                {{ t.settings.sectionTasksWhat }} {{ t.settings.noFallback }}
                {{ t.settings.testAllWhat }}
              </p>

              <div class="table-scroll">
                <table class="table tasks-table">
                  <thead>
                    <tr>
                      <th>{{ t.settings.taskTableHead.task }}</th>
                      <th>{{ t.settings.taskTableHead.via }}</th>
                      <th>{{ t.settings.taskTableHead.model }}</th>
                      <th>{{ t.settings.taskTableHead.status }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="task in TASK_ORDER" :key="task">
                      <td class="task-cell">
                        <span class="task-name">{{ t.settings.taskNames[task] }}</span>
                        <span class="task-what">{{ t.settings.taskWhat[task] }}</span>
                      </td>

                      <!-- 服務：只有一種的任務顯示成文字並說為什麼 —— 一個不能動的下拉選單看起來像壞了。 -->
                      <td class="via-cell">
                        <select
                          v-if="viaOptions(task).length > 1"
                          :value="tasks[task].via"
                          @change="
                            setVia(
                              task,
                              ($event.target as HTMLSelectElement).value as ConnectionKind,
                            )
                          "
                        >
                          <option v-for="kind in viaOptions(task)" :key="kind" :value="kind">
                            {{ t.settings.connectionNames[kind] }}
                          </option>
                        </select>
                        <template v-else>
                          <span class="fixed">{{
                            t.settings.connectionNames[tasks[task].via]
                          }}</span>
                          <span class="task-what">{{ viaFixedText(task) }}</span>
                        </template>
                      </td>

                      <td class="model-cell">
                        <!--
                          CLI 那一列是文字欄，因為**那支 CLI 不吐模型清單**；
                          HTTP 連線列得出清單就給下拉，位址改了或還沒列就退回手打。
                        -->
                        <input
                          v-if="tasks[task].via === 'cli'"
                          type="text"
                          :value="tasks[task].model"
                          :placeholder="t.settings.agentModelDefault"
                          @input="
                            setModelOf(task, ($event.target as HTMLInputElement).value, false)
                          "
                          @change="autosave()"
                        />
                        <select
                          v-else-if="modelsFor(tasks[task].via)?.length"
                          :value="tasks[task].model"
                          @change="setModelOf(task, ($event.target as HTMLSelectElement).value)"
                        >
                          <option value="">{{ t.settings.modelPick }}</option>
                          <!-- 存檔裡的模型不在清單上（例如被 ollama rm 掉了）也要留在選項裡，不然它會安靜地變成空的。 -->
                          <option
                            v-if="
                              tasks[task].model.length > 0 &&
                              !modelsFor(tasks[task].via)?.includes(tasks[task].model)
                            "
                            :value="tasks[task].model"
                          >
                            {{ tasks[task].model }}
                          </option>
                          <option
                            v-for="name in modelsFor(tasks[task].via)"
                            :key="name"
                            :value="name"
                          >
                            {{ name }}
                          </option>
                        </select>
                        <input
                          v-else
                          type="text"
                          :value="tasks[task].model"
                          :placeholder="t.settings.modelPickText"
                          @input="
                            setModelOf(task, ($event.target as HTMLInputElement).value, false)
                          "
                          @change="autosave()"
                        />
                        <span v-if="tasks[task].via === 'cli'" class="task-what">
                          {{ t.settings.agentModelHint }}
                        </span>
                        <span v-else-if="modelsFor(tasks[task].via) === null" class="task-what">
                          {{ t.settings.modelUnlisted }}
                        </span>
                        <!-- 建議值是使用者按下去的，不是我們替他填的；只對走本機 Ollama 的任務顯示 -->
                        <span v-if="recommendationFor(task)" class="task-what">
                          <button
                            class="link"
                            type="button"
                            :title="recommendWhy(task)"
                            @click="setModelOf(task, RECOMMENDED_TASK_ALL[task])"
                          >
                            {{ fill(t.settings.taskRecommend, { model: recommendationFor(task) }) }}
                          </button>
                        </span>
                        <!-- **這一句比那個下拉選單重要。** 換嵌入模型的代價要在按下去之前就看得到 -->
                        <span v-if="task === 'embed'" class="task-what warn">
                          {{ t.settings.embedSwitch }}
                        </span>
                      </td>

                      <!-- 狀態：**存檔那一份的**。改了就存，所以它跟左邊一致；還在打的那一格，最上面那一行會說。 -->
                      <td class="status-cell">
                        <template v-if="rowOf(task) !== null">
                          <span class="state">
                            <span
                              :class="['state-dot', dotOf(rowOf(task))]"
                              aria-hidden="true"
                            ></span>
                            {{ t.settings.taskState[rowOf(task)!.state] }}
                            <span v-if="rowOf(task)!.version" class="muted">
                              · {{ rowOf(task)!.version }}
                            </span>
                            <!-- context 大小跟版本同一行：它是配對規則看的數字，而「不知道」與「很小」是兩件事 -->
                            <span
                              v-if="rowOf(task)!.state === 'ready' && task !== 'embed'"
                              class="muted"
                            >
                              · {{ contextText(rowOf(task)!) }}
                            </span>
                          </span>
                          <span
                            v-if="rowOf(task)!.state === 'unreachable' && rowOf(task)!.detail"
                            class="task-what"
                          >
                            {{ rowOf(task)!.detail }}
                          </span>
                          <!-- **格式保證要看得到。** 事後檢查是一種降級，而它被允許的條件是說出來（ADR-0030）。 -->
                          <span
                            v-if="rowOf(task)!.jsonMode"
                            :class="['task-what', 'json-mode', rowOf(task)!.jsonMode!.mode]"
                          >
                            <span class="json-label">{{ t.settings.jsonModeLabel }}</span>
                            {{ jsonModeText(rowOf(task)!.jsonMode) }}
                          </span>
                          <span
                            v-if="
                              rowOf(task)!.jsonMode &&
                              (rowOf(task)!.jsonMode!.mode === 'object' ||
                                rowOf(task)!.jsonMode!.mode === 'none') &&
                              rowOf(task)!.jsonMode!.detail
                            "
                            class="task-what mono"
                          >
                            {{ rowOf(task)!.jsonMode!.detail }}
                          </span>
                          <!-- **會不會上網搜尋也要看得到**（ADR-0034）：找來源那一列，CLI 是參數給的、線上是量的。 -->
                          <span
                            v-if="rowOf(task)!.browse"
                            :class="[
                              'task-what',
                              'json-mode',
                              rowOf(task)!.browse!.state === 'no' ? 'none' : '',
                            ]"
                          >
                            <span class="json-label">{{ t.settings.browseLabel }}</span>
                            {{ browseText(rowOf(task)!.browse!) }}
                          </span>
                          <span v-if="missingText(rowOf(task)!)" class="missing">
                            {{ missingText(rowOf(task)!) }}
                          </span>
                        </template>
                        <!-- 「儲存並測試」的結果逐列寫在這裡。 -->
                        <span v-if="testResults[task]" class="test-result">
                          {{ testResults[task] }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- ── 段落二：模型服務（設定一次，上面挑）── -->
            <section class="card">
              <h2>{{ t.settings.sectionConnections }}</h2>
              <p class="card-what">{{ t.settings.sectionConnectionsWhat }}</p>

              <!--
                三塊各自框起來，標題列同一個形狀：名字＋一行「在哪裡跑、花不花錢」、現況、
                右上角「儲存並檢查」。2026-09-19 之前三塊只隔一條線、用詞各自不同，使用者說分不清。
              -->
              <!-- Claude Code -->
              <div class="conn">
                <header>
                  <div class="conn-name">
                    <h3>{{ t.settings.connectionNames.cli }}</h3>
                    <span class="conn-kind">{{ t.settings.connectionKind.cli }}</span>
                  </div>
                  <span class="summary">{{ connectionSummary('cli') }}</span>
                  <button
                    type="button"
                    :disabled="checking !== null"
                    @click="checkConnection('cli')"
                  >
                    {{ checking === 'cli' ? t.settings.listing : t.settings.listModels }}
                  </button>
                </header>
                <p class="hint">{{ t.settings.connectionWhat.cli }}</p>
                <label class="field">
                  <span>{{ t.settings.cliCommand }}</span>
                  <input
                    v-model="cliCommand"
                    type="text"
                    placeholder="claude"
                    @change="autosave()"
                  />
                  <small>{{ t.settings.cliCommandHint }}</small>
                </label>
                <p v-if="checkResult?.kind === 'cli'" class="hint result">{{ checkResult.text }}</p>
              </div>

              <!-- Ollama -->
              <div class="conn">
                <header>
                  <div class="conn-name">
                    <h3>{{ t.settings.connectionNames.ollama }}</h3>
                    <span class="conn-kind">{{ t.settings.connectionKind.ollama }}</span>
                  </div>
                  <span class="summary">{{ connectionSummary('ollama') }}</span>
                  <button
                    type="button"
                    :disabled="checking !== null"
                    @click="checkConnection('ollama')"
                  >
                    {{ checking === 'ollama' ? t.settings.listing : t.settings.listModels }}
                  </button>
                </header>
                <p class="hint">{{ t.settings.connectionWhat.ollama }}</p>
                <label class="field">
                  <span>{{ t.settings.baseUrl }}</span>
                  <input
                    v-model="ollamaUrl"
                    type="text"
                    :placeholder="OLLAMA_DEFAULT_URL"
                    @change="autosave()"
                  />
                </label>
                <p v-if="checkResult?.kind === 'ollama'" class="hint result">
                  {{ checkResult.text }}
                </p>
                <p v-else-if="isStale('ollama')" class="hint">{{ t.settings.listStale }}</p>
              </div>

              <!-- OpenAI 相容 API -->
              <div class="conn">
                <header>
                  <div class="conn-name">
                    <h3>{{ t.settings.connectionNames.openai }}</h3>
                    <span class="conn-kind">{{ t.settings.connectionKind.openai }}</span>
                  </div>
                  <span class="summary">{{ connectionSummary('openai') }}</span>
                  <button
                    type="button"
                    :disabled="checking !== null || openaiUrl.trim().length === 0"
                    @click="checkConnection('openai')"
                  >
                    {{ checking === 'openai' ? t.settings.listing : t.settings.listModels }}
                  </button>
                </header>
                <p class="hint">{{ t.settings.connectionWhat.openai }}</p>
                <div class="field-row">
                  <label class="field">
                    <span>{{ t.settings.baseUrl }}</span>
                    <input
                      v-model="openaiUrl"
                      type="text"
                      :placeholder="t.settings.openaiBaseUrlPlaceholder"
                      @change="autosave()"
                    />
                  </label>
                  <!-- **只填變數的名字。** 金鑰本身不進任何一個檔（2026-09-08）。 -->
                  <label class="field">
                    <span>{{ t.settings.apiKeyEnv }}</span>
                    <input
                      v-model="openaiKeyEnv"
                      type="text"
                      placeholder="OPENAI_API_KEY"
                      @change="autosave()"
                    />
                    <small>{{ t.settings.apiKeyEnvHint }}</small>
                  </label>
                </div>
                <!-- **不合格的名字會被丟掉，所以不存，而且當場說。** -->
                <p v-if="apiKeyEnvBad" class="callout">{{ t.settings.apiKeyEnvBad }}</p>
                <p
                  v-if="connectionOf('openai') && connectionOf('openai')!.auth !== 'none'"
                  :class="['hint', connectionOf('openai')!.auth]"
                >
                  {{ t.settings.auth[connectionOf('openai')!.auth] }}
                </p>
                <!--
                  **讀不到的時候，畫面上要說得出「怎麼設」與「為什麼還是讀不到」。**
                  最常見的原因不是打錯字，是 `setx` 之後沒有重開 —— 環境變數是
                  行程啟動時繼承的一份拷貝，已經開著的程式讀不到後來設的值。
                -->
                <template
                  v-if="
                    openaiKeyEnv.trim().length > 0 && connectionOf('openai')?.auth === 'env-missing'
                  "
                >
                  <p class="hint">{{ t.settings.apiKeyHowTo }}</p>
                  <code class="setx"
                    >setx {{ openaiKeyEnv.trim() }} "&lt;{{
                      t.settings.apiKeyPlaceholder
                    }}&gt;"</code
                  >
                  <p class="callout">{{ t.settings.apiKeyRestart }}</p>
                  <div class="actions">
                    <button type="button" @click="refresh()">{{ t.settings.apiKeyRecheck }}</button>
                  </div>
                </template>
                <p v-if="checkResult?.kind === 'openai'" class="hint result">
                  {{ checkResult.text }}
                </p>
                <p v-else-if="openaiUrl.trim().length > 0 && isStale('openai')" class="hint">
                  {{ t.settings.listStale }}
                </p>
              </div>
            </section>

            <!--
              ── 段落三：診斷 ──
              **預設關著，而且那句說明要說出代價。** 打開之後每一次呼叫都會把
              整份提示詞（抽取那一條裡是整篇正文）寫進專題資料夾 —— 它長得很快。
            -->
            <section class="card diagnostics">
              <h2>{{ t.settings.diagnosticsTitle }}</h2>
              <label class="check">
                <input v-model="logModelCalls" type="checkbox" @change="autosave()" />
                <span>{{ t.settings.logModelCalls }}</span>
              </label>
              <p class="hint">{{ t.settings.logModelCallsWhat }}</p>
              <p class="hint">{{ t.settings.logModelCallsWhere }}</p>
              <p class="hint">{{ t.settings.logModelCallsCost }}</p>
            </section>
          </template>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
/* 頁寬、卡片、表格、表單、按鈕都在 base.css；這裡只有這一頁自己的東西。 */
.settings-page > h1 {
  margin-bottom: var(--s4);
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s4);
  align-items: start;
}
.content {
  min-width: 0;
}
/* 寬畫面：分頁列直排在左邊。 */
@media (min-width: 1000px) {
  .layout {
    grid-template-columns: 180px minmax(0, 1fr);
    gap: var(--s5);
  }
  .tabs.side {
    flex-direction: column;
    position: sticky;
    top: var(--s4);
  }
  .tabs.side > .on {
    box-shadow: inset 2px 0 0 var(--ring-selected);
  }
}
.tabs.side {
  margin-bottom: var(--s2);
}

/* ── 任務那張表 ── */
.tasks-table td {
  padding: var(--s3) 10px var(--s3) 0;
}
.tasks-table th {
  padding-left: 0;
}
.task-cell {
  min-width: 16ch;
  max-width: 26ch;
}
.task-name {
  display: block;
  color: var(--text);
}
.task-what {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-label);
  color: var(--text-muted);
  line-height: 1.5;
}
.task-what.warn {
  color: var(--text-secondary);
}
.via-cell {
  min-width: 12ch;
  white-space: nowrap;
}
.via-cell .fixed {
  color: var(--text-secondary);
}
.via-cell .task-what {
  white-space: normal;
  max-width: 14ch;
}
.model-cell {
  min-width: 20ch;
  max-width: 30ch;
}
.model-cell select,
.model-cell input {
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
}
.status-cell {
  min-width: 24ch;
}
.status-cell > * {
  display: block;
}
.state {
  color: var(--text);
}
.state .muted {
  font-family: var(--mono);
  font-size: var(--fs-label);
}
/* 狀態點跟頂列同一套：實心＝可以用、空心＝還沒設定、虛線＝有問題。**靠形狀分**；
   「可以用」不上綠色（綠色留給「完成」），只有「有問題」用琥珀。 */
.state-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--text-tertiary);
  vertical-align: middle;
  margin-right: 6px;
}
.state-dot.ready {
  background: var(--text-secondary);
  border-color: var(--text-secondary);
}
.state-dot.problem {
  border-style: dashed;
  border-color: var(--edge-pending);
}
/**
 * 格式保證。**事後檢查與不支援刻意不給顏色** —— 琥珀已經是待查證、紅已經是真的壞掉了，
 * 而「這個端點的格式由 Cyclosa 事後檢查」兩者都不是，它是按下去之前要知道的事。
 * 所以強調靠字重與一條左邊界。
 */
.json-mode .json-label {
  color: var(--text-secondary);
  margin-right: 4px;
}
.json-mode.object,
.json-mode.none {
  padding-left: 8px;
  border-left: 3px solid var(--line-strong);
  font-weight: 600;
  color: var(--text);
}
.missing {
  margin-top: 6px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
  border-left: 2px solid var(--edge-pending);
  padding-left: 8px;
}
.test-result {
  margin-top: var(--s2);
  font-size: var(--fs-label);
  color: var(--text-secondary);
}

/* ── 卡片標題列：標題在左、動作在右 ── */
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s3);
  flex-wrap: wrap;
  margin-bottom: var(--s3);
}
.card-head > h2 {
  margin: 0;
}
.card-action {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
  margin-left: auto;
}
.card-action .hint {
  font-size: var(--fs-label);
}

/* ── 模型服務：三塊各自框起來 ── */
.conn {
  padding: var(--s3) var(--s4);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.conn + .conn {
  margin-top: var(--s3);
}
.conn > header {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
  margin-bottom: var(--s2);
}
.conn-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.conn-name > h3 {
  margin: 0;
}
.conn-kind {
  font-size: var(--fs-label);
  color: var(--text-tertiary);
}
.conn .summary {
  /* 現況那一段可以縮、可以換行，按鈕才留得在同一列（768 寬時 CLI 的版本字串很長）。 */
  flex: 1 1 12ch;
  min-width: 0;
  font-size: var(--fs-label);
  color: var(--text-secondary);
  font-family: var(--mono);
}
.conn > header > button {
  margin-left: auto;
}
.conn > .hint {
  margin-bottom: var(--s3);
  max-width: 68ch;
}
.conn > .hint.result {
  margin: var(--s2) 0 0;
  color: var(--text-secondary);
}
.conn .actions {
  margin-top: var(--s1);
}
.hint.env-missing {
  color: var(--edge-pending);
}
/* setx 那一行要看得出來是可以整行複製的指令 */
.setx {
  display: block;
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: var(--fs-label);
  user-select: all;
  overflow-x: auto;
}

/* ── 診斷 ── */
.diagnostics .check {
  margin-bottom: var(--s2);
}
.diagnostics .hint {
  margin-top: 6px;
  max-width: 68ch;
}

/*
 * ── 改了就存的那一行 ──
 * 貼在頁面最上面、捲動時跟著走（外層 `main.scroll` 是捲動容器）。
 * 點的形狀跟任務表的狀態點同一套：實心＝存好了、空心＝還沒動過／還在打、虛線＝要處理。
 * 「存好了」不上綠色（綠色留給「完成」，ADR-0018）；「沒存成」才用紅。
 */
.save-state {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s2);
  margin: 0 0 var(--s4);
  padding: var(--s2) var(--s3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: var(--fs-small);
}
.save-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--text-tertiary);
}
.save-state.saved .save-dot {
  background: var(--text-secondary);
  border-color: var(--text-secondary);
}
.save-state.saving .save-dot {
  border-style: dotted;
  border-color: var(--text-secondary);
}
.save-state.held,
.save-state.editing {
  border-color: var(--edge-pending);
}
.save-state.held .save-dot,
.save-state.editing .save-dot {
  border-style: dashed;
  border-color: var(--edge-pending);
}
.save-state.failed {
  border-color: var(--ui-danger);
  color: var(--text);
}
.save-state.failed .save-dot {
  border-color: var(--ui-danger);
  background: var(--ui-danger);
}
.save-text {
  flex: 1 1 24ch;
  min-width: 0;
}
</style>

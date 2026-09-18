<script setup lang="ts">
/**
 * 模型設定（ui-workflows §5）。
 *
 * ## 三個角色都列出來，即使其中一個還沒做
 *
 * `embed` 是後面的階段的事，而它照樣佔一格 ——
 * **少列一個角色，使用者會以為這個工具只有兩種模型。**
 *
 * ## 「列出來」與「實際打一次」是兩件事
 *
 * 打開這一頁不該產生費用，所以它只讀 `/api/providers`
 * （agent 那邊只跑 `--version`、chat 那邊只讀 `/api/tags`）。
 * 「實際打一次」是使用者按的按鈕，**而那個按鈕旁邊要先講它會不會花錢**。
 */
import { computed, onMounted, ref, watch } from 'vue';

import {
  api,
  type ApiError,
  type ChatTask,
  type ChatTransport,
  type JsonModeReport,
  type ModelTask,
  type ProvidersPayload,
  type ProviderRole,
  type ProviderStatus,
} from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';
import SourcesPanel from '../components/SourcesPanel.vue';
import StatusGuide from '../components/StatusGuide.vue';
import StoragePanel from '../components/StoragePanel.vue';

const payload = ref<ProvidersPayload | null>(null);
const error = ref<ApiError | null>(null);
const saving = ref(false);
const savedAt = ref(0);

const tab = ref<'models' | 'sources' | 'guide' | 'storage'>('models');

/** `chat` 走哪一種協定。**不自動偵測** —— 見 server 的 `ChatTransport`。 */
const transport = ref<ChatTransport>('ollama');
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
const baseUrl = ref('');
const model = ref('');
const command = ref('');
/** CLI 的 `--model`。**空字串 ＝ 不帶，用 CLI 自己的預設** */
const agentModel = ref('');
/** **變數的名字，不是金鑰。** 金鑰不進任何一個檔（2026-09-08 的決定）。 */
const apiKeyEnv = ref('');

/**
 * 伺服器收不收這個名字。**跟 `providers/config.ts` 的 `ENV_NAME` 是同一條**
 * （`tests/guards/api-key-env-name.test.ts` 逼兩邊一致）。
 *
 * **在這裡檢查是因為不合格的名字會被安靜地丟掉**：`apiKeyEnvOf` 回 `null`，
 * 存檔成功、畫面重新載入之後那一格變空的 —— 使用者看到的是「我打的字不見了」。
 * 2026-09-18 真的踩到：一個叫 `OPENAI_API_KEY_v1` 的變數（結尾是小寫）。
 */
const apiKeyEnvBad = computed(() => {
  const name = apiKeyEnv.value.trim();
  return name.length > 0 && !/^[A-Z][A-Z0-9_]{1,63}$/.test(name);
});
// 小寫直接轉大寫。Windows 的環境變數不分大小寫，所以 `OPENAI_API_KEY_v1` 與
// `OPENAI_API_KEY_V1` 讀到的是同一個；與其擋下來叫使用者重打，不如替他轉。
// 減號、空白之類的還是會被上面那條擋 —— 那才是「有人把金鑰貼進來」的訊號。
watch(apiKeyEnv, (value) => {
  const upper = value.toUpperCase();
  if (upper !== value) apiKeyEnv.value = upper;
});

/**
 * 表單上的連線跟存檔裡的不是同一條。
 *
 * 模型清單、格式保證、測試結果都是**對存檔那一條端點**量的 ——
 * 一切到「OpenAI 相容端點」還把 Ollama 的 22 個模型列在下拉選單裡，
 * 使用者會以為那些是這個端點的模型（2026-09-18 真的發生）。
 * 不是同一條的時候：模型改成手打、格式保證不顯示、測試結果清掉，
 * 並且說明「存檔後才會列出這個端點的模型」。
 */
const endpointChanged = computed(() => {
  const saved = payload.value?.config.chat;
  const savedTransport = saved?.transport ?? 'ollama';
  const savedUrl = (saved?.baseUrl ?? '').trim();
  return transport.value !== savedTransport || baseUrl.value.trim() !== savedUrl;
});
const embedBaseUrl = ref('');
const embedModel = ref('');
/**
 * 留下每一次模型呼叫的紀錄。**預設關著。**
 *
 * 開關在這裡而不是在設定檔裡，理由是時機：
 * **遇到一個壞掉的抽取結果的當下，才是唯一能把它重現下來的時機。**
 */
const logModelCalls = ref(false);

/**
 * 量測選出來的建議值（`docs/research/embedding-choice.md`，2026-09-09）。
 * **顯示成一顆可以按的建議，不自己填進去** —— 換這個模型的代價比另外兩個大，
 * 所以它要是使用者按下去的，不是我們替他決定的。
 */
const RECOMMENDED_EMBED = 'qwen3-embedding:4b';
// **這兩個字串在 src/infrastructure/providers/config.ts 也有一份。**
// web 與 server 是兩份建置，所以只能各抄一份 ——
// tests/guards/recommended-models.test.ts 釘著它們一致。
const RECOMMENDED_CHAT = 'qwen3.5:4b';
/**
 * 逐任務的建議值。**同一輪量測的另一半** ——
 * `extract` 就是上面那一個（預設模型要能單獨把兩件事都跑完），
 * 所以只有 `angles` 是不一樣的字串。
 */
const RECOMMENDED_TASK: Record<ChatTask, string> = {
  angles: 'granite4.2:8b',
  extract: RECOMMENDED_CHAT,
};

/**
 * 表格那一欄用的建議值，**四個任務都有一格**。
 *
 * `find-sources` 是空字串 —— **那不是「沒有建議」，是「建議不要帶」**：
 * agent 的模型由 CLI 自己的設定決定，而我們沒有量過在那一邊換模型的效果
 * （`docs/research/` 那幾輪量的是本機 chat 模型）。
 * 空字串讓那一列不出現建議按鈕，而不是出現一個沒有依據的名字。
 */
const RECOMMENDED_TASK_ALL: Record<ModelTask, string> = {
  'find-sources': '',
  ...RECOMMENDED_TASK,
  embed: RECOMMENDED_EMBED,
};

/** 兩個任務的覆寫。**空字串 ＝ 跟著預設**，不是「沒有模型」 */
const taskModels = ref<Record<ChatTask, string>>({ angles: '', extract: '' });
const testing = ref<ProviderRole | null>(null);
const testResult = ref<{ role: ProviderRole; text: string } | null>(null);

const CAPABILITY_FLAGS = ['browse', 'tools', 'json_schema', 'vision'] as const;

async function load(): Promise<void> {
  const r = await api.providers();
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  payload.value = r.data;
  transport.value = r.data.config.chat?.transport ?? 'ollama';
  baseUrl.value = r.data.config.chat?.baseUrl ?? '';
  model.value = r.data.config.chat?.model ?? '';
  command.value = r.data.config.agent?.command ?? '';
  agentModel.value = r.data.config.agent?.model ?? '';
  apiKeyEnv.value = r.data.config.chat?.apiKeyEnv ?? '';
  embedBaseUrl.value = r.data.config.embed?.baseUrl ?? '';
  embedModel.value = r.data.config.embed?.model ?? '';
  taskModels.value = {
    angles: r.data.config.chat?.taskModels?.angles ?? '',
    extract: r.data.config.chat?.taskModels?.extract ?? '',
  };
  logModelCalls.value = r.data.config.diagnostics?.logModelCalls === true;
  // **2026-09-10 起這一區不再收起來。** 原本它是一個 `<details>`，
  // 而「收起來的設定等於看不見的設定」—— 現在它是一張永遠攤開的表，
  // 所以那個「設過就自動打開」的補丁不再需要。
}
onMounted(() => void load());

/**
 * 換連線方式的時候**只動那個還是預設值的位址**。
 *
 * 從本機 Ollama 換到線上端點時，`127.0.0.1:11434` 幾乎一定不是使用者要的 ——
 * 清掉讓範例位址顯示出來；換回來時空著就填回 Ollama 的慣例位址。
 * 使用者自己打過的位址一律不碰。
 */
function switchTransport(next: ChatTransport): void {
  if (next === transport.value) return;
  if (next === 'openai' && baseUrl.value.trim() === OLLAMA_DEFAULT_URL) baseUrl.value = '';
  if (next === 'ollama' && baseUrl.value.trim().length === 0) baseUrl.value = OLLAMA_DEFAULT_URL;
  transport.value = next;
  // 模型名跟著端點走：切回存檔那一條就填回存檔的模型，切到另一條就清空 ——
  // 留著 Ollama 的模型名在 OpenAI 端點的欄位裡，存了就是一個不存在的模型。
  const saved = payload.value?.config.chat;
  model.value = saved && next === saved.transport ? saved.model : '';
  // 上一次「實際打一次」打的是另一條連線，留著會被當成這一條的結果。
  if (testResult.value?.role === 'chat') testResult.value = null;
}

/** 這個角色的下拉選單列哪一份。**嵌入永遠是本機那一份**，不跟著 chat 走。 */
function modelsFor(role: ProviderRole): string[] | null {
  if (role === 'embed') return payload.value?.embedModels ?? null;
  return payload.value?.chatModels ?? null;
}

/**
 * 「格式保證」那一行。**量的時間一定要跟著** —— 一句沒有日期的量測結果，
 * 會在對方升版之後變成假話，而這個專案自己就寫過一句那樣的話。
 */
function jsonModeText(report: JsonModeReport | null): string {
  if (report === null) return '';
  if (report.mode === 'schema' && report.checkedAt === null) return t.settings.jsonModeNative;
  const text = t.settings.jsonMode[report.mode];
  if (report.checkedAt === null) return text;
  const date = new Date(report.checkedAt).toLocaleString('zh-TW', { hour12: false });
  return `${text}（${fill(t.settings.jsonCheckedAt, { date })}）`;
}

/** 四個任務那張表的資料來源。**順序由 server 決定**，畫面不自己排。 */
const taskRows = computed(() => payload.value?.taskReadiness ?? []);

/** chat 任務那一列實際會跑的模型的格式保證。其餘任務沒有這一件事。 */
function chatTaskJson(task: ModelTask): JsonModeReport | null {
  return payload.value?.chatTasks.find((row) => row.task === task)?.jsonMode ?? null;
}

function taskReadinessOf(task: ModelTask): { ok: boolean; missing: string[] } {
  return payload.value?.taskReadiness.find((r) => r.task === task) ?? { ok: false, missing: [] };
}

/**
 * 表格那一格現在填的是什麼、改了要寫回哪裡。
 *
 * **三個角色的模型欄位形狀本來就不一樣**（chat 是逐任務覆寫、
 * embed 是角色自己那一個、agent 是 CLI 的旗標），而表格要它們看起來一樣。
 * 這兩支就是那個轉換 —— **它只在這一層做，不往下傳**。
 */
function modelValueOf(task: ModelTask): string {
  if (task === 'find-sources') return agentModel.value;
  if (task === 'embed') return embedModel.value;
  return taskModels.value[task];
}

function setModelOf(task: ModelTask, value: string): void {
  if (task === 'find-sources') agentModel.value = value;
  else if (task === 'embed') embedModel.value = value;
  else taskModels.value[task] = value;
}

/** 這一個任務缺什麼。**跟角色層那一行是同一種句子，但講的是這個模型** */
function taskMissingText(task: ModelTask): string {
  const flags = taskReadinessOf(task).missing;
  if (flags.length === 0) return '';
  const names = flags.map(
    (f) => t.settings.capabilityNames[f as keyof typeof t.settings.capabilityNames] ?? f,
  );
  return fill(t.settings.missing, { flags: names.join('、') });
}

const statuses = computed(() => payload.value?.statuses ?? []);

function readinessOf(role: ProviderRole): { ok: boolean; missing: string[] } {
  return payload.value?.readiness.find((r) => r.role === role) ?? { ok: false, missing: [] };
}

function missingText(role: ProviderRole): string {
  const flags = readinessOf(role).missing;
  if (flags.length === 0) return '';
  const names = flags.map(
    (f) => t.settings.capabilityNames[f as keyof typeof t.settings.capabilityNames] ?? f,
  );
  return fill(t.settings.missing, { flags: names.join('、') });
}

function contextText(status: ProviderStatus): string {
  const n = status.capabilities.context_tokens;
  // **0 是「不知道」不是「只有 0 個」** —— 兩者的訊息不一樣
  return n > 0
    ? fill(t.settings.contextTokens, { n: n.toLocaleString('en-US') })
    : t.settings.contextUnknown;
}

async function save(): Promise<void> {
  saving.value = true;
  const r = await api.saveProviders({
    version: 1,
    chat:
      baseUrl.value.trim().length === 0
        ? null
        : {
            transport: transport.value,
            baseUrl: baseUrl.value.trim(),
            model: model.value.trim(),
            apiKeyEnv: apiKeyEnv.value.trim().length === 0 ? null : apiKeyEnv.value.trim(),
            taskModels: {
              angles: taskModels.value.angles.trim(),
              extract: taskModels.value.extract.trim(),
            },
          },
    agent:
      command.value.trim().length === 0
        ? null
        : { command: command.value.trim(), args: [], model: agentModel.value.trim() },
    embed:
      embedBaseUrl.value.trim().length === 0
        ? null
        : { baseUrl: embedBaseUrl.value.trim(), model: embedModel.value.trim() },
    diagnostics: { logModelCalls: logModelCalls.value },
  });
  saving.value = false;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  payload.value = r.data;
  savedAt.value = Date.now();
}

async function test(role: ProviderRole): Promise<void> {
  testing.value = role;
  testResult.value = null;
  const r = await api.testProvider(role);
  testing.value = null;
  if (!r.ok) {
    testResult.value = { role, text: errorMessages[r.error.code] ?? r.error.code };
    return;
  }
  const outcome = r.data.ok
    ? fill(t.settings.testOk, { ms: r.data.elapsedMs })
    : `${t.settings.testFailed}：${errorMessages[r.data.code ?? ''] ?? String(r.data.code)}`;
  // 線上端點按這顆會重量一次格式支援 —— 量到什麼要當場說出來，不是等重新整理。
  const measured =
    r.data.jsonMode !== null && r.data.jsonMode.checkedAt !== null
      ? ` ${fill(t.settings.testJsonMode, { mode: jsonModeText(r.data.jsonMode) })}`
      : '';
  testResult.value = { role, text: `${outcome}${measured}` };
  if (measured.length > 0) await load();
}
</script>

<template>
  <!--
    **捲動的是外層，內容的寬度是內層。**

    原本兩件事寫在同一個元素上（`max-width` ＋ `margin-inline: auto` ＋
    `overflow-y: auto`），而那有兩個後果：

    1. **`margin-inline: auto` 會把 flex 子項的 `stretch` 取消掉** ——
       於是這一塊的寬度變成「由內容決定」，不是「填滿再置中」。
       實測：模型分頁 760px、來源網站分頁 785px，同一頁寬度會跟著內容跳。
    2. 捲軸跟著內容跑到畫面中間，右邊留一大片空白 ——
       在寬螢幕上那看起來就是壞的。
  -->
  <main class="settings">
    <div :class="['inner', { wide: tab === 'sources' }]">
      <h1>{{ t.settings.title }}</h1>

      <nav class="tabs">
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
          兩邊讀同一份宣告，所以不會漂。
        -->
        <button :class="{ on: tab === 'guide' }" @click="tab = 'guide'">
          {{ t.settings.tabs.guide }}
        </button>
        <!--
          **資料位置。** 第一次啟動不再問「資料要放哪」，
          所以這一頁存在的第一個理由是**告訴使用者它在哪** ——
          方便的代價不該是「我不知道我的東西在哪個資料夾」。
        -->
        <button :class="{ on: tab === 'storage' }" @click="tab = 'storage'">
          {{ t.settings.tabs.storage }}
        </button>
      </nav>

      <SourcesPanel v-if="tab === 'sources'" />
      <StatusGuide v-else-if="tab === 'guide'" />
      <StoragePanel v-else-if="tab === 'storage'" />

      <template v-else>
        <ErrorPanel v-if="error" :error="error" />

        <p class="no-fallback">{{ t.settings.noFallback }}</p>

        <h2 class="group">{{ t.settings.sectionModels }}</h2>
        <p class="group-what">{{ t.settings.sectionModelsWhat }}</p>

        <section v-for="status in statuses" :key="status.role" class="role">
          <header>
            <h2>{{ t.settings.roles[status.role] }}</h2>
            <span :class="['state', status.state]">{{ t.settings.state[status.state] }}</span>
            <span v-if="status.detail" class="detail">{{ status.detail }}</span>
          </header>
          <p class="what">{{ t.settings.roleWhat[status.role] }}</p>

          <!-- 名稱、版本、用途 —— 三件事分開列。**版本問不到就說問不到**，
             不要編一個看起來像版本號的東西。 -->
          <!-- chat 的版本是對存檔那一條端點問的；連線換了就不是這一條的事。 -->
          <dl
            v-if="status.state === 'ready' && !(status.role === 'chat' && endpointChanged)"
            class="facts"
          >
            <dt>{{ t.settings.version }}</dt>
            <dd :class="{ muted: !status.version }">
              {{ status.version || t.settings.versionUnknown }}
            </dd>
          </dl>

          <!-- chat：連線方式 ＋ 位址 ＋ 模型。模型從偵測到的清單挑，**不要讓人猜怎麼拼** -->
          <div v-if="status.role === 'chat'" class="form">
            <!--
              **連線方式由人選，不自動偵測**。兩種協定 Ollama 都答得出來，
              猜錯的代價是「關掉思考」與「指定 context」那兩個量出來的設定安靜地消失。
            -->
            <div class="transport">
              <span>{{ t.settings.transport }}</span>
              <label v-for="kind in ['ollama', 'openai'] as const" :key="kind" class="choice">
                <input
                  type="radio"
                  name="chat-transport"
                  :checked="transport === kind"
                  @change="switchTransport(kind)"
                />
                {{ t.settings.transportNames[kind] }}
              </label>
            </div>
            <p class="hint">{{ t.settings.transportWhat[transport] }}</p>
            <label>
              <span>{{ t.settings.chatBaseUrl }}</span>
              <input
                v-model="baseUrl"
                type="text"
                :placeholder="
                  transport === 'openai'
                    ? t.settings.chatBaseUrlOpenaiPlaceholder
                    : OLLAMA_DEFAULT_URL
                "
              />
            </label>
            <label>
              <span>{{ t.settings.chatModel }}</span>
              <select v-if="!endpointChanged && modelsFor('chat')?.length" v-model="model">
                <option value="">
                  {{
                    transport === 'openai'
                      ? t.settings.chatModelPickOnline
                      : t.settings.chatModelPick
                  }}
                </option>
                <option v-for="name in modelsFor('chat')" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
              <input v-else v-model="model" type="text" />
            </label>
            <!--
              **建議值只對本機 Ollama 顯示。** 那個數字是在這台機器的 Ollama 上量的
              （`docs/research/chat-choice.md`），拿去建議一個線上端點上的模型名，
              是用一份沒有量過那個世界的結果替它背書。
            -->
            <p v-if="transport === 'ollama'" class="hint">
              <!-- 建議值是使用者按下去的，不是我們替他填的 -->
              <button
                v-if="model !== RECOMMENDED_CHAT"
                class="link"
                type="button"
                @click="model = RECOMMENDED_CHAT"
              >
                {{ fill(t.settings.chatRecommend, { model: RECOMMENDED_CHAT }) }}
              </button>
              {{ t.settings.chatRecommendWhy }}
            </p>
            <!-- 連線換了：清單、格式保證都是對存檔那一條量的，這裡先說清楚下一步是什麼。 -->
            <p v-if="endpointChanged" class="hint">{{ t.settings.chatEndpointChanged }}</p>
            <p v-else-if="payload && payload.chatModels === null" class="hint">
              {{
                transport === 'openai'
                  ? t.settings.chatModelsUnreachableOnline
                  : t.settings.chatModelsUnreachable
              }}
            </p>
            <!-- **格式保證要看得到。** 事後檢查是一種降級，而它被允許的條件是說出來（ADR-0030）。 -->
            <p
              v-if="!endpointChanged && status.state === 'ready' && status.jsonMode"
              :class="['hint', 'json-mode', status.jsonMode.mode]"
            >
              <span class="json-label">{{ t.settings.jsonModeLabel }}</span>
              {{ jsonModeText(status.jsonMode) }}
            </p>
            <!--
              **端點自己說的理由，原文照登。** 事後檢查與不支援的時候才有意義 ——
              2026-09-11 在真的端點上觸發 `none` 的是一個嵌入模型，
              而那個原因（does not support chat）只有對方說得出來。
            -->
            <p
              v-if="
                !endpointChanged &&
                status.jsonMode &&
                (status.jsonMode.mode === 'object' || status.jsonMode.mode === 'none') &&
                status.jsonMode.detail
              "
              class="hint json-detail"
            >
              {{ status.jsonMode.detail }}
            </p>

            <!-- **逐任務覆寫搬到下面那一段了**（2026-09-10）。
               這裡只留「這個角色連到哪、用哪個預設模型」——
               而「每一件事各自跑哪一個」是一張跨角色的表，
               放在一個角色底下的話，找來源與嵌入永遠不會出現在它旁邊。 -->
            <!-- **只填變數的名字。** 金鑰本身不進任何一個檔（2026-09-08）。 -->
            <label>
              <span>{{ t.settings.apiKeyEnv }}</span>
              <input v-model="apiKeyEnv" type="text" placeholder="OPENAI_API_KEY" />
            </label>
            <p class="hint">{{ t.settings.apiKeyEnvHint }}</p>
            <!-- **不合格的名字會被丟掉，所以要在按下儲存之前就說。** -->
            <p v-if="apiKeyEnvBad" class="hint warn">{{ t.settings.apiKeyEnvBad }}</p>
            <p v-if="status.auth && status.auth !== 'none'" :class="['hint', status.auth]">
              {{ t.settings.auth[status.auth] }}
            </p>
            <!--
              **讀不到的時候，畫面上要說得出「怎麼設」與「為什麼還是讀不到」。**
              最常見的原因不是打錯字，是 `setx` 之後沒有重開 —— 環境變數是
              行程啟動時繼承的一份拷貝，已經開著的程式讀不到後來設的值。
              一個只寫「沒偵測到」的畫面會讓人一直重打那個名字。
            -->
            <template v-if="apiKeyEnv.trim().length > 0 && status.auth === 'env-missing'">
              <p class="hint">{{ t.settings.apiKeyHowTo }}</p>
              <code class="setx"
                >setx {{ apiKeyEnv.trim() }} "&lt;{{ t.settings.apiKeyPlaceholder }}&gt;"</code
              >
              <p class="hint warn">{{ t.settings.apiKeyRestart }}</p>
              <div class="actions">
                <button type="button" @click="load()">{{ t.settings.apiKeyRecheck }}</button>
              </div>
            </template>
          </div>

          <div v-else-if="status.role === 'agent'" class="form">
            <label>
              <span>{{ t.settings.agentCommand }}</span>
              <input v-model="command" type="text" placeholder="claude" />
            </label>
            <p class="hint">{{ t.settings.agentCommandHint }}</p>
            <!--
              `--model`。**空著是一個有效的選擇**，不是沒設定 ——
              那表示「用 CLI 自己的預設」，而那個預設是使用者在 CLI 那邊設的。
            -->
            <label>
              <span>{{ t.settings.agentModel }}</span>
              <input v-model="agentModel" type="text" :placeholder="t.settings.agentModelDefault" />
            </label>
            <p class="hint">{{ t.settings.agentModelHint }}</p>
          </div>

          <!--
            embed：位址 ＋ 模型，**沒有金鑰欄位**（只接本機端點）。

            **那句「換掉要全部重算」比下拉選單重要**，所以它在選單上面而不是下面 ——
            三個角色裡只有這一個換掉有不可逆的代價，而畫面上看不出來的話
            使用者會把它當成另外兩個一樣可以隨便換。
          -->
          <div v-else-if="status.role === 'embed'" class="form">
            <p class="warn">{{ t.settings.embedIrreversible }}</p>
            <label>
              <span>{{ t.settings.embedBaseUrl }}</span>
              <input v-model="embedBaseUrl" type="text" />
            </label>
            <label>
              <span>{{ t.settings.embedModel }}</span>
              <!-- **嵌入的清單是它自己那個位址的**，不跟著 chat 走（v0.18.0 之前是同一份）。 -->
              <select v-if="modelsFor('embed')?.length" v-model="embedModel">
                <option value="">{{ t.settings.embedModelPick }}</option>
                <option v-for="name in modelsFor('embed')" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
              <input v-else v-model="embedModel" type="text" />
            </label>
            <p class="hint">
              <!-- **建議值是使用者按下去的，不是我們替他填的** -->
              <button
                v-if="embedModel !== RECOMMENDED_EMBED"
                class="link"
                type="button"
                @click="embedModel = RECOMMENDED_EMBED"
              >
                {{ fill(t.settings.embedRecommend, { model: RECOMMENDED_EMBED }) }}
              </button>
              {{ t.settings.embedRecommendWhy }}
            </p>
            <p class="hint">{{ t.settings.embedNotWired }}</p>
          </div>

          <!-- 能力宣告攤開來。**它是配對規則真正看的東西** -->
          <div v-if="status.state === 'ready' && status.role !== 'embed'" class="caps">
            <span class="caps-label">{{ t.settings.capabilities }}</span>
            <span
              v-for="flag in CAPABILITY_FLAGS"
              :key="flag"
              :class="['cap', { on: status.capabilities[flag] }]"
            >
              {{ t.settings.capabilityNames[flag] }}
            </span>
            <span class="cap ctx">{{ contextText(status) }}</span>
          </div>

          <p v-if="missingText(status.role)" class="missing">{{ missingText(status.role) }}</p>

          <!-- **三個角色都可以「實際打一次」（v0.11.0）。**
             `embed` 原本沒有這顆按鈕，因為那個角色還沒有實作 ——
             而它其實是最該按的一個：模型在不在清單上，設定頁載入時就看得到；
             **它吐不吐得出向量，只有真的打一次才知道**。 -->
          <div class="actions">
            <button :disabled="testing !== null" @click="test(status.role)">
              {{ testing === status.role ? t.settings.testing : t.settings.test }}
            </button>
            <!-- **會不會花錢要在按之前就說。** agent 是外部服務，chat 是本機 -->
            <span class="hint">
              {{
                status.role === 'agent'
                  ? t.settings.testCostsMoney
                  : status.role === 'chat' && status.transport === 'openai'
                    ? t.settings.testCostsMoneyOnline
                    : t.settings.testFree
              }}
            </span>
            <span v-if="testResult?.role === status.role" class="test-result">
              {{ testResult.text }}
            </span>
          </div>
        </section>

        <!--
          ── 段落二：各任務模型 ───────────────────────────────

          **這張表是跨角色的**，而那是它存在的全部理由。
          逐任務覆寫原本放在 `chat` 那一區底下，於是「找來源」與「嵌入」
          永遠不會出現在它旁邊 —— 而使用者問的是
          「我能不能替每一件事各挑一個模型」，那需要一份完整清單。

          每一列右邊那句話講的是**實際會跑的那一個**，不是上面設定的預設 ——
          覆寫之後兩者會分岔，而分岔的時候只看預設欄位是看不出來的。
        -->
        <h2 class="group">{{ t.settings.sectionTasks }}</h2>
        <p class="group-what">{{ t.settings.sectionTasksWhat }}</p>

        <!--
          **這張表有自己的捲動容器。**

          四欄的最小寬度加起來是 728px，而模型分頁的行長是 760px
          （扣掉左右內距之後只剩 712px）—— 也就是說**它在任何視窗寬度下
          都塞不進去**，而原本的後果是整個設定頁橫向捲動 31px。

          讓表自己捲，比把行長放寬好：760px 是給那一欄表單文字的行長，
          不該為了一張表而改掉。
        -->
        <div class="table-scroll">
          <table class="tasks-table">
            <thead>
              <tr>
                <th>{{ t.settings.taskTableHead.task }}</th>
                <th>{{ t.settings.taskTableHead.role }}</th>
                <th>{{ t.settings.taskTableHead.model }}</th>
                <th>{{ t.settings.taskTableHead.status }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in taskRows" :key="row.task">
                <td>
                  <span class="task-name">{{ t.settings.taskNames[row.task] }}</span>
                  <span class="task-what">{{ t.settings.taskWhat[row.task] }}</span>
                </td>
                <td class="role-cell">{{ t.settings.roles[row.role] }}</td>
                <td>
                  <!--
                    agent 那一列是文字欄不是下拉，因為**那支 CLI 不吐模型清單** ——
                    給一個空的下拉比給一個文字欄糟：它看起來像「一個都沒有」。
                  -->
                  <input
                    v-if="row.role === 'agent'"
                    type="text"
                    :value="modelValueOf(row.task)"
                    :placeholder="t.settings.agentModelDefault"
                    @input="setModelOf(row.task, ($event.target as HTMLInputElement).value)"
                  />
                  <select
                    v-else-if="
                      (row.role !== 'chat' || !endpointChanged) && modelsFor(row.role)?.length
                    "
                    :value="modelValueOf(row.task)"
                    @change="setModelOf(row.task, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">
                      {{
                        row.role === 'chat' ? t.settings.chatTaskFollow : t.settings.embedModelPick
                      }}
                    </option>
                    <option v-for="name in modelsFor(row.role)" :key="name" :value="name">
                      {{ name }}
                    </option>
                  </select>
                  <input
                    v-else
                    type="text"
                    :value="modelValueOf(row.task)"
                    @input="setModelOf(row.task, ($event.target as HTMLInputElement).value)"
                  />
                  <!-- 建議值是使用者按下去的，不是我們替他填的 -->
                  <!-- chat 的建議是在本機 Ollama 上量的，線上端點不顯示（見上面那一段）。 -->
                  <button
                    v-if="
                      RECOMMENDED_TASK_ALL[row.task] &&
                      modelValueOf(row.task) !== RECOMMENDED_TASK_ALL[row.task] &&
                      (row.role !== 'chat' || transport === 'ollama')
                    "
                    class="link"
                    type="button"
                    @click="setModelOf(row.task, RECOMMENDED_TASK_ALL[row.task])"
                  >
                    {{
                      fill(t.settings.chatTaskRecommend, { model: RECOMMENDED_TASK_ALL[row.task] })
                    }}
                  </button>
                </td>
                <td :class="['task-status', row.ok ? 'ok' : 'warn']">
                  <!-- **實際會跑的那一個。** 空著代表跟著角色的預設，或者根本沒設定。 -->
                  <span v-if="row.model.length > 0" class="runs">
                    {{ fill(t.settings.chatTaskRuns, { model: row.model }) }}
                  </span>
                  <span v-else class="runs muted">{{ t.settings.taskFollowsDefault }}</span>
                  <span v-if="row.overridden" class="badge">{{ t.settings.taskOverridden }}</span>
                  <!-- 覆寫的模型各有各的格式保證；事後檢查的那幾列要標出來（ADR-0030）。 -->
                  <span
                    v-if="chatTaskJson(row.task)?.mode === 'object'"
                    class="badge"
                    :title="jsonModeText(chatTaskJson(row.task))"
                  >
                    {{ t.settings.taskJsonObject }}
                  </span>
                  <span v-if="taskMissingText(row.task)" class="missing">
                    {{ taskMissingText(row.task) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!--
          ── 段落三：診斷 ───────────────────────────────────

          **預設關著，而且那句說明要說出代價。** 打開之後每一次呼叫都會把
          整份提示詞（抽取那一條裡是整篇正文）寫進專題資料夾 —— 它長得很快。
          放在最後，因為它不是跑起來需要的東西。
        -->
        <section class="block diagnostics">
          <h2>{{ t.settings.diagnosticsTitle }}</h2>
          <label class="check">
            <input v-model="logModelCalls" type="checkbox" />
            <span>{{ t.settings.logModelCalls }}</span>
          </label>
          <p class="hint">{{ t.settings.logModelCallsWhat }}</p>
          <p class="hint">{{ t.settings.logModelCallsWhere }}</p>
          <p class="hint">{{ t.settings.logModelCallsCost }}</p>
        </section>

        <div class="save">
          <button class="primary" :disabled="saving" @click="save">{{ t.settings.save }}</button>
          <span v-if="savedAt" class="hint">{{ t.settings.saved }}</span>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}

.tabs button {
  font: inherit;
  font-size: 13px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.tabs button.on {
  border-color: var(--ui-selected);
  color: var(--text);
}

.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 6px 0 0;
  font-size: 12px;
}

.facts dt {
  color: var(--text-tertiary);
}

.facts dd {
  margin: 0;
}

.facts dd.muted {
  color: var(--text-muted);
}

.hint.env-missing {
  color: var(--edge-pending);
}

/**
 * **置中，而且兩個分頁的寬度不一樣。**
 *
 * 第一版有 `max-width` 卻沒有 `margin: auto`，於是在寬螢幕上整頁擠在左邊 ——
 * 而隔壁的專題清單是 `max-width: 1200px; margin: 0 auto`。
 * **同一個 app 的兩頁對「寬螢幕怎麼辦」給了不同答案**，那不是風格，那是漏掉。
 *
 * 模型那一頁是一組表單，760px 是給它的行長；
 * **來源網站是一張八欄的表**，塞進 760px 之後每一格都在換行。
 *
 * ## 2026-09-11：捲動與寬度拆成兩層
 *
 * 原本兩件事都在 `.settings` 上，而那有一個量得到的後果：
 * **`margin-inline: auto` 把 flex 子項的 `stretch` 取消掉了** ——
 * 於是這一塊變成「由內容決定寬度」。實測模型分頁 760px、
 * 來源網站分頁 785px，**同一頁的寬度跟著內容跳**，
 * 而捲軸也跟著跑到畫面中間、右邊留一大片空白。
 *
 * 現在外層負責填滿與捲動（捲軸在視窗邊緣），內層負責行長與置中。
 */
.settings {
  overflow-y: auto;
  height: 100%;
  width: 100%;
}

.inner {
  padding: 20px 24px 60px;
  max-width: 760px;
  margin-inline: auto;
}

.inner.wide {
  max-width: 1180px;
}
h1 {
  font-size: 16px;
  margin: 0 0 6px;
}
h2 {
  font-size: 14px;
  margin: 0;
}
.no-fallback {
  color: var(--text-tertiary);
  font-size: 13px;
  margin: 0 0 18px;
}
.role {
  border: 1px solid var(--line-subtle);
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  margin-bottom: 14px;
}

/* 診斷那一區跟角色那幾格同一個外框 —— 它不是一個特別的東西。 */
.block {
  border: 1px solid var(--line-subtle);
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.block h2 {
  margin-bottom: 10px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 8px;
  cursor: pointer;
}
.diagnostics .hint {
  margin-top: 6px;
  line-height: 1.6;
}
.role header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.state {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-tertiary);
}
/**
 * **三種狀態一個顏色都不用。**
 *
 * 「還沒設定」不是壞掉，是還沒做；「連不上」多半只是 Ollama 沒開 ——
 * **紅色留給真的壞掉的東西**（ADR-0018 規則 3）。
 *
 * 而「可以用」也不上色。第一版給了它選取青，而**青色在這個工具裡
 * 只有一個意思：選取**（ADR-0018 規則 1，每個顏色一個意思）。
 * 一個「可以用」的徽章染成青的，等於在畫面上多開一個那個顏色的意思。
 *
 * 第二重編碼用邊框的虛實，跟下面的能力宣告同一套：
 * **實線＝有，虛線＝沒有。**
 */
.state {
  border-style: dashed;
}
.state.ready {
  color: var(--text);
  border-style: solid;
}
.detail {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--mono);
}
.what {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 8px 0 12px;
}
.form {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}
.form label {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
/**
 * 逐任務覆寫那一區。
 *
 * **收起來的是選單，不是狀態** —— 每個任務「實際會跑哪一個」在收起來的時候
 * 仍然要看得到，所以那幾行不在 `<details>` 的內容裡……
 * 除了它們確實在。這是刻意的取捨：兩件事都跟著預設時那三行完全是重複資訊
 * （上面的模型欄位就是答案）。
 *
 * **2026-09-10 從一個 `<details>` 換成一張永遠攤開的表。**
 * 收起來的設定等於看不見的設定，而一個看不見的覆寫正是
 * 「設了沒有生效」那種抱怨的來源。
 */

/* ── 兩個段落的標題 ────────────────────────────────── */
.group {
  margin: 28px 0 4px;
  font-size: 15px;
  color: var(--text);
}
.group:first-of-type {
  margin-top: 12px;
}
.group-what {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-tertiary);
  max-width: 62ch;
  line-height: 1.6;
}

/* ── 各任務模型那張表 ──────────────────────────────── */

/**
 * **寬表格自己捲，不要讓整頁跟著捲。**
 *
 * 這張表四欄的最小寬度加起來是 728px，而這一頁的行長是 760px
 * （扣掉內距只剩 712px）—— 它在**任何**視窗寬度下都塞不進去。
 * 修之前的症狀是整個設定頁固定橫向溢出 31px。
 */
.table-scroll {
  overflow-x: auto;
  /* 捲動容器在 flex／grid 底下要這一行才縮得下去。這裡是一般流，
     但寫著它，之後版面改成 flex 的時候不會安靜地壞掉。 */
  min-width: 0;
}

.tasks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tasks-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 6px 10px 6px 0;
  border-bottom: 1px solid var(--line);
}
.tasks-table td {
  padding: 10px 10px 10px 0;
  border-bottom: 1px solid var(--line-subtle);
  vertical-align: top;
}
.tasks-table td:first-child {
  min-width: 12ch;
}
.task-name {
  display: block;
  color: var(--text-secondary);
}
.task-what {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-muted);
  /* **這一欄的最大寬度就是整張表的最小寬度。** 34ch 的時候四欄加起來
     是 728px，而這一頁的內容寬只有 712px —— 也就是永遠差一點。 */
  max-width: 26ch;
  line-height: 1.5;
}
.role-cell {
  color: var(--text-muted);
  white-space: nowrap;
}
/* **實際會跑的那一個。** 覆寫之後上面的預設欄位就不再等於它 */
.task-status {
  display: table-cell;
  min-width: 16ch;
}
.task-status .runs {
  display: block;
  color: var(--text-secondary);
}
.task-status .runs.muted {
  color: var(--text-muted);
}
.task-status.warn .runs {
  color: var(--edge-pending);
}
.task-status .missing {
  display: block;
  margin-top: 4px;
  font-size: 12px;
}
.badge {
  display: inline-block;
  margin-top: 4px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  font-size: 11px;
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
  font-size: 12px;
  user-select: all;
  overflow-x: auto;
}
/** 同一行裡的兩件事之間。**不是標點** —— 它是版面 */
.sep {
  color: var(--text-muted);
  margin: 0 4px;
}
input,
select {
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text);
  padding: 5px 8px;
  font-size: 13px;
  font-family: inherit;
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 10px 0;
}
.caps-label {
  font-size: 12px;
  color: var(--text-muted);
}
.cap {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--line-subtle);
  color: var(--text-muted);
}
/* 有這個能力就是實心邊框 —— **第二重編碼不是只有顏色**（ADR-0018） */
.cap.on {
  color: var(--text-secondary);
  border-color: var(--line);
  border-style: solid;
}
.cap:not(.on) {
  border-style: dashed;
}
.cap.ctx {
  border-style: none;
  font-family: var(--mono);
}
.missing {
  font-size: 13px;
  color: var(--text-secondary);
  border-left: 2px solid var(--edge-pending);
  padding-left: 10px;
  margin: 8px 0;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}
/**
 * 「換掉要全部重算」那一句。
 *
 * **刻意不給它一個顏色。** ADR-0018 第 1 條是「每個顏色一個意思」，
 * 而琥珀已經是待查證、紅已經是真的壞掉了 —— 這一句兩者都不是，
 * 它是「按下去之前要知道的事」。所以強調靠**字重與一條左邊界**，
 * 跟 ADR-0024 把已讀改標在字重上是同一個判斷。
 */
.warn {
  margin: 0 0 4px;
  padding-left: 10px;
  border-left: 3px solid var(--line-strong);
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}
/** 建議值那顆 —— 看起來是文字，但它是按鈕，因為它會改一個欄位。 */
.link {
  background: none;
  border: none;
  padding: 0;
  margin-right: 4px;
  font: inherit;
  font-weight: 700;
  color: var(--ui-action);
  cursor: pointer;
  text-decoration: underline;
}
.test-result {
  font-size: 12px;
  color: var(--text-secondary);
}
.save {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
/**
 * **`.primary` 不在這裡重畫。** 2026-09-18 之前這裡把字塗成 `--ui-action`，
 * 而全域 `tokens.css` 把底也塗成同一個藍 —— 「儲存」變成一個看不見字的藍方塊。
 * 填色按鈕只在 `tokens.css` 定義一次。
 */
button {
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text);
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
button:hover:not(:disabled) {
  background: var(--bg-hover);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 連線方式：兩個選項並排，標籤與選項同一條基線。 */
.transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  font-size: 13px;
}
.transport .choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
/**
 * 格式保證。**事後檢查與不支援刻意不給顏色** —— 跟上面 `.warn` 同一個判斷：
 * 琥珀已經是待查證、紅已經是真的壞掉了，而「這個端點的格式由 Cyclosa 事後檢查」
 * 兩者都不是，它是按下去之前要知道的事。所以強調靠字重與一條左邊界。
 * （不支援的時候，下面那一行「缺少：輸出符合格式」已經會出現。）
 */
.json-mode .json-label {
  color: var(--text-secondary);
  margin-right: 6px;
}
.json-detail {
  font-family: var(--mono);
  word-break: break-all;
}
.json-mode.object,
.json-mode.none {
  padding-left: 10px;
  border-left: 3px solid var(--line-strong);
  font-weight: 700;
  color: var(--text);
}
</style>

<script setup lang="ts">
/**
 * 模型設定（ui-workflows §5，Stage 9）。
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
import { computed, onMounted, ref } from 'vue';

import {
  api,
  type ApiError,
  type ChatTask,
  type ProvidersPayload,
  type ProviderRole,
  type ProviderStatus,
} from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';
import SourcesPanel from '../components/SourcesPanel.vue';

const payload = ref<ProvidersPayload | null>(null);
const error = ref<ApiError | null>(null);
const saving = ref(false);
const savedAt = ref(0);

const tab = ref<'models' | 'sources'>('models');

const baseUrl = ref('');
const model = ref('');
const command = ref('');
/** **變數的名字，不是金鑰。** 金鑰不進任何一個檔（2026-09-08 的決定）。 */
const apiKeyEnv = ref('');
const embedBaseUrl = ref('');
const embedModel = ref('');

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

/** 兩個任務的覆寫。**空字串 ＝ 跟著預設**，不是「沒有模型」 */
const taskModels = ref<Record<ChatTask, string>>({ angles: '', extract: '' });
/** 預設是收起來的 —— 大多數人只要一個模型 */
const showTasks = ref(false);

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
  baseUrl.value = r.data.config.chat?.baseUrl ?? '';
  model.value = r.data.config.chat?.model ?? '';
  command.value = r.data.config.agent?.command ?? '';
  apiKeyEnv.value = r.data.config.chat?.apiKeyEnv ?? '';
  embedBaseUrl.value = r.data.config.embed?.baseUrl ?? '';
  embedModel.value = r.data.config.embed?.model ?? '';
  taskModels.value = {
    angles: r.data.config.chat?.taskModels?.angles ?? '',
    extract: r.data.config.chat?.taskModels?.extract ?? '',
  };
  // **設過覆寫就把那一區打開。** 收起來的設定等於看不見的設定，
  // 而一個看不見的覆寫正是「設了沒有生效」那種抱怨的來源。
  if (taskModels.value.angles.length > 0 || taskModels.value.extract.length > 0) {
    showTasks.value = true;
  }
}
onMounted(() => void load());

const chatTasks = computed(() => payload.value?.chatTasks ?? []);

function taskReadinessOf(task: ChatTask): { ok: boolean; missing: string[] } {
  return payload.value?.chatReadiness.find((r) => r.task === task) ?? { ok: false, missing: [] };
}

/** 這一個任務缺什麼。**跟角色層那一行是同一種句子，但講的是這個模型** */
function taskMissingText(task: ChatTask): string {
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
            baseUrl: baseUrl.value.trim(),
            model: model.value.trim(),
            apiKeyEnv: apiKeyEnv.value.trim().length === 0 ? null : apiKeyEnv.value.trim(),
            taskModels: {
              angles: taskModels.value.angles.trim(),
              extract: taskModels.value.extract.trim(),
            },
          },
    agent: command.value.trim().length === 0 ? null : { command: command.value.trim(), args: [] },
    embed:
      embedBaseUrl.value.trim().length === 0
        ? null
        : { baseUrl: embedBaseUrl.value.trim(), model: embedModel.value.trim() },
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
  testResult.value = {
    role,
    text: r.data.ok
      ? fill(t.settings.testOk, { ms: r.data.elapsedMs })
      : `${t.settings.testFailed}：${errorMessages[r.data.code ?? ''] ?? String(r.data.code)}`,
  };
}
</script>

<template>
  <main :class="['settings', { wide: tab === 'sources' }]">
    <h1>{{ t.settings.title }}</h1>

    <nav class="tabs">
      <button :class="{ on: tab === 'models' }" @click="tab = 'models'">
        {{ t.settings.tabs.models }}
      </button>
      <button :class="{ on: tab === 'sources' }" @click="tab = 'sources'">
        {{ t.settings.tabs.sources }}
      </button>
    </nav>

    <SourcesPanel v-if="tab === 'sources'" />

    <template v-else>
      <ErrorPanel v-if="error" :error="error" />

      <p class="no-fallback">{{ t.settings.noFallback }}</p>

      <section v-for="status in statuses" :key="status.role" class="role">
        <header>
          <h2>{{ t.settings.roles[status.role] }}</h2>
          <span :class="['state', status.state]">{{ t.settings.state[status.state] }}</span>
          <span v-if="status.detail" class="detail">{{ status.detail }}</span>
        </header>
        <p class="what">{{ t.settings.roleWhat[status.role] }}</p>

        <!-- 名稱、版本、用途 —— 三件事分開列。**版本問不到就說問不到**，
           不要編一個看起來像版本號的東西。 -->
        <dl v-if="status.state === 'ready'" class="facts">
          <dt>{{ t.settings.version }}</dt>
          <dd :class="{ muted: !status.version }">
            {{ status.version || t.settings.versionUnknown }}
          </dd>
        </dl>

        <!-- chat：位址 ＋ 模型。模型從偵測到的清單挑，**不要讓人猜怎麼拼** -->
        <div v-if="status.role === 'chat'" class="form">
          <label>
            <span>{{ t.settings.chatBaseUrl }}</span>
            <input v-model="baseUrl" type="text" />
          </label>
          <label>
            <span>{{ t.settings.chatModel }}</span>
            <select v-if="payload?.chatModels?.length" v-model="model">
              <option value="">{{ t.settings.chatModelPick }}</option>
              <option v-for="name in payload.chatModels" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <input v-else v-model="model" type="text" />
          </label>
          <p class="hint">
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
          <p v-if="payload && payload.chatModels === null" class="hint">
            {{ t.settings.chatModelsUnreachable }}
          </p>

          <!--
            逐任務覆寫。**收起來的是選單，不是狀態** ——
            即使收著，下面每個任務「實際會跑哪一個」還是看得到，
            因為覆寫之後上面那個模型欄位就不再等於實際會跑的東西。
          -->
          <details class="tasks" :open="showTasks">
            <summary>{{ t.settings.chatTaskTitle }}</summary>
            <p class="hint">{{ t.settings.chatTaskWhy }}</p>
            <div v-for="row in chatTasks" :key="row.task" class="task">
              <label>
                <span>{{ t.settings.chatTaskNames[row.task] }}</span>
                <select
                  v-if="payload?.chatModels?.length"
                  :value="taskModels[row.task]"
                  @change="taskModels[row.task] = ($event.target as HTMLSelectElement).value"
                >
                  <option value="">{{ t.settings.chatTaskFollow }}</option>
                  <option v-for="name in payload.chatModels" :key="name" :value="name">
                    {{ name }}
                  </option>
                </select>
                <input v-else v-model="taskModels[row.task]" type="text" />
              </label>
              <p class="what">{{ t.settings.chatTaskWhat[row.task] }}</p>
              <p class="hint">
                <button
                  v-if="taskModels[row.task] !== RECOMMENDED_TASK[row.task]"
                  class="link"
                  type="button"
                  @click="taskModels[row.task] = RECOMMENDED_TASK[row.task]"
                >
                  {{ fill(t.settings.chatTaskRecommend, { model: RECOMMENDED_TASK[row.task] }) }}
                </button>
                {{ t.settings.chatTaskRecommendWhy[row.task] }}
              </p>
              <!-- **實際會跑的那一個，以及它現在的狀態。**
                 角色層那一格講的是預設模型，覆寫之後兩者會分岔。 -->
              <p v-if="row.model.length === 0" class="hint warn">
                {{ t.settings.chatTaskUnset }}
              </p>
              <p v-else :class="['hint', taskReadinessOf(row.task).ok ? '' : 'warn']">
                {{ fill(t.settings.chatTaskRuns, { model: row.model }) }}
                <span class="sep">·</span>
                {{ t.settings.state[row.state] }}
                <template v-if="taskMissingText(row.task)">
                  <span class="sep">·</span>{{ taskMissingText(row.task) }}
                </template>
              </p>
            </div>
          </details>
          <!-- **只填變數的名字。** 金鑰本身不進任何一個檔（2026-09-08）。 -->
          <label>
            <span>{{ t.settings.apiKeyEnv }}</span>
            <input v-model="apiKeyEnv" type="text" placeholder="OPENAI_API_KEY" />
          </label>
          <p class="hint">{{ t.settings.apiKeyEnvHint }}</p>
          <p v-if="status.auth && status.auth !== 'none'" :class="['hint', status.auth]">
            {{ t.settings.auth[status.auth] }}
          </p>
        </div>

        <div v-else-if="status.role === 'agent'" class="form">
          <label>
            <span>{{ t.settings.agentCommand }}</span>
            <input v-model="command" type="text" placeholder="claude" />
          </label>
          <p class="hint">{{ t.settings.agentCommandHint }}</p>
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
            <select v-if="payload?.chatModels?.length" v-model="embedModel">
              <option value="">{{ t.settings.embedModelPick }}</option>
              <option v-for="name in payload.chatModels" :key="name" :value="name">
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

        <div v-if="status.role !== 'embed'" class="actions">
          <button :disabled="testing !== null" @click="test(status.role)">
            {{ testing === status.role ? t.settings.testing : t.settings.test }}
          </button>
          <!-- **會不會花錢要在按之前就說。** agent 是外部服務，chat 是本機 -->
          <span class="hint">
            {{ status.role === 'agent' ? t.settings.testCostsMoney : t.settings.testFree }}
          </span>
          <span v-if="testResult?.role === status.role" class="test-result">
            {{ testResult.text }}
          </span>
        </div>
      </section>

      <div class="save">
        <button class="primary" :disabled="saving" @click="save">{{ t.settings.save }}</button>
        <span v-if="savedAt" class="hint">{{ t.settings.saved }}</span>
      </div>
    </template>
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
 */
.settings {
  padding: 20px 24px 60px;
  overflow-y: auto;
  height: 100%;
  max-width: 760px;
  margin-inline: auto;
}

.settings.wide {
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
  font-family: var(--font-mono);
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
 * （上面的模型欄位就是答案），而**設過覆寫的話這一區會自動打開**（`load()`）。
 */
.tasks {
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin-bottom: 10px;
}
.tasks summary {
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.task {
  display: grid;
  gap: 4px;
  margin-top: 10px;
}
.task label {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.task .what {
  margin: 0;
  font-size: 12px;
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
  font-family: var(--font-mono);
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
button.primary {
  border-color: var(--action-primary);
  color: var(--action-primary);
}
</style>

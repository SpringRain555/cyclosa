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
}
onMounted(() => void load());

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
          },
    agent: command.value.trim().length === 0 ? null : { command: command.value.trim(), args: [] },
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
  <main class="settings">
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
          <p v-if="payload && payload.chatModels === null" class="hint">
            {{ t.settings.chatModelsUnreachable }}
          </p>
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

        <!-- 能力宣告攤開來。**它是配對規則真正看的東西** -->
        <div v-if="status.state === 'ready'" class="caps">
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

.settings {
  padding: 20px 24px 60px;
  overflow-y: auto;
  height: 100%;
  max-width: 760px;
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

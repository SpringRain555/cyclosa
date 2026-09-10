<script setup lang="ts">
/**
 * 設定頁的「資料位置」。
 *
 * ## 這一頁的第一個工作是「告訴你它在哪」
 *
 * Stage 15 之後**第一次啟動不會問資料要放哪裡** —— 它自己建在
 * `%LOCALAPPDATA%\Cyclosa\data`。方便的代價是使用者可能完全不知道
 * 自己的東西在哪個資料夾裡，而那些東西是他花時間蒐集來的。
 *
 * 所以這一頁把路徑**印出來**（連同記著它的那個指標檔），
 * 換位置反而是次要的功能。
 *
 * ## 搬家的門在伺服器端
 *
 * 有作業在跑的時候不准搬（`IO_DATA_ROOT_BUSY`）——
 * 搬家會把 `case.sqlite` 從一個正在寫它的行程底下抽走。
 * 前端這裡不預先判斷，直接送出去讓伺服器答 ——
 * 這個畫面不知道現在有沒有作業在跑，而它也不該知道。
 */
import { onMounted, ref } from 'vue';
import { api, type ApiError, type DataRootInfo } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';

const root = ref<DataRootInfo | null>(null);
const error = ref<ApiError | null>(null);
const target = ref('');
const busy = ref(false);
const done = ref<string | null>(null);

async function load(): Promise<void> {
  const r = await api.dataRoot();
  if (r.ok) {
    root.value = r.data;
    error.value = null;
  } else {
    error.value = r.error;
  }
}

async function move(): Promise<void> {
  const to = target.value.trim();
  if (to.length === 0) return;
  busy.value = true;
  error.value = null;
  done.value = null;
  const r = await api.moveDataRoot(to);
  busy.value = false;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  root.value = r.data;
  target.value = '';
  done.value = fill(t.settings.storage.moveDone, { to: r.data.dataRoot });
}

onMounted(load);
</script>

<template>
  <section class="storage">
    <p class="what">{{ t.settings.storage.what }}</p>

    <dl v-if="root">
      <dt>{{ t.settings.storage.current }}</dt>
      <dd>
        <code class="mono">{{ root.dataRoot }}</code>
      </dd>
      <dt>{{ t.settings.storage.pointer }}</dt>
      <dd>
        <code class="mono small">{{ root.pointerPath }}</code>
      </dd>
    </dl>

    <h2>{{ t.settings.storage.moveTitle }}</h2>
    <p class="what">{{ t.settings.storage.moveWhat }}</p>
    <!-- **有作業在跑就不准搬** —— 那句話說在前面，不要等按下去才知道。 -->
    <p class="what">{{ t.settings.storage.moveBusyRuns }}</p>

    <form @submit.prevent="move">
      <input
        v-model="target"
        type="text"
        :placeholder="t.settings.storage.movePlaceholder"
        :disabled="busy"
      />
      <button type="submit" :disabled="busy || target.trim().length === 0">
        {{ busy ? t.settings.storage.moveBusy : t.settings.storage.moveSubmit }}
      </button>
    </form>

    <p v-if="done" class="done">{{ done }}</p>
    <ErrorPanel v-if="error" :error="error" />
  </section>
</template>

<style scoped>
.storage {
  max-width: 720px;
}
.what {
  color: var(--text-dim);
  font-size: 13px;
  margin: 6px 0;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 16px 0 22px;
  align-items: baseline;
}
dt {
  color: var(--text-dim);
  font-size: 13px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
h2 {
  font-size: 15px;
  margin: 22px 0 0;
}
form {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
form input {
  flex: 1;
}
.small {
  font-size: 12px;
}
.done {
  color: var(--ui-success);
  font-size: 13px;
}
</style>

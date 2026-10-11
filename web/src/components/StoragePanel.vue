<script setup lang="ts">
/**
 * 設定頁的「資料位置」。
 *
 * ## 這一頁的第一個工作是「告訴你它在哪」
 *
 * 第一次啟動問過一次三選一（ADR-0037），之後就再也不會提起 ——
 * 使用者可能早就忘了自己的東西在哪個資料夾裡，而那些東西是花時間蒐集來的。
 *
 * 所以這一頁把路徑**印出來**，連同「程式怎麼找到它」：記在指標檔裡，
 * 或者從程式資料夾／使用者資料夾那兩個固定位置找到（那兩種沒有指標檔）。
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

/**
 * 重建範例專題。
 *
 * **已經有一份的時候伺服器回 `CASE_NAME_DUPLICATE`**，而那不是一個錯誤 ——
 * 它是「你已經有了」。所以這裡把它翻成一句話，不丟到錯誤面板上。
 */
const sampleBusy = ref(false);
const sampleNote = ref<string | null>(null);
const sampleError = ref<ApiError | null>(null);

async function rebuildSample(): Promise<void> {
  sampleBusy.value = true;
  sampleNote.value = null;
  sampleError.value = null;
  const r = await api.rebuildSample();
  sampleBusy.value = false;
  if (r.ok) {
    sampleNote.value = fill(t.settings.storage.sampleDone, {
      items: r.data.items,
      entities: r.data.entities,
      edges: r.data.edges,
    });
    return;
  }
  if (r.error.code === 'CASE_NAME_DUPLICATE') {
    sampleNote.value = t.settings.storage.sampleExists;
    return;
  }
  sampleError.value = r.error;
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
      <!-- **只有記在指標檔裡的才說「記在哪」** —— 另外兩種根本沒有那個檔，印出它的路徑會讓人去找一個不存在的檔。 -->
      <template v-if="root.source === 'pointer'">
        <dt>{{ t.settings.storage.pointer }}</dt>
        <dd>
          <code class="mono small">{{ root.pointerPath }}</code>
        </dd>
      </template>
      <template v-else>
        <dt>{{ t.settings.storage.foundBy }}</dt>
        <dd class="small">
          {{
            root.source === 'program-folder'
              ? t.settings.storage.foundInProgramFolder
              : t.settings.storage.foundInUserFolder
          }}
        </dd>
      </template>
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

    <!--
      **範例專題。** 它放在這一頁而不是專題清單上，理由是
      「它是關於這份安裝的事」，不是關於某一個專題的事 ——
      跟資料放哪裡屬於同一類問題。
    -->
    <h2>{{ t.settings.storage.sampleTitle }}</h2>
    <p class="what">{{ t.settings.storage.sampleWhat }}</p>
    <p class="what">{{ t.settings.storage.sampleLicence }}</p>
    <!-- **這一句一定要說**：那幾條已確認的關聯是示範資料。 -->
    <p class="what">{{ t.settings.storage.sampleNotReal }}</p>
    <button type="button" :disabled="sampleBusy" @click="rebuildSample">
      {{ sampleBusy ? t.settings.storage.sampleBusy : t.settings.storage.sampleBuild }}
    </button>
    <p v-if="sampleNote" class="done">{{ sampleNote }}</p>
    <ErrorPanel v-if="sampleError" :error="sampleError" />
  </section>
</template>

<style scoped>
.storage {
  max-width: 720px;
}
/* 跟設定頁的 `.what` 與 `.facts dt` 同一組 token —— 兩頁並排，說明文字的深淺要一樣。 */
.what {
  color: var(--text-secondary);
  font-size: var(--fs-small);
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
  color: var(--text-tertiary);
  font-size: var(--fs-small);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.storage h2 {
  margin-top: 22px;
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
  font-size: var(--fs-label);
}
.done {
  color: var(--ui-success);
  font-size: var(--fs-small);
}
</style>

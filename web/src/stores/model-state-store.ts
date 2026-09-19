import { defineStore } from 'pinia';
import { ref } from 'vue';

import { api, type ProvidersPayload } from '../api';

/**
 * 頂列那一顆模型狀態點（v0.24.0）。
 *
 * **它要跨頁存在，而且設定頁一存就要跟著變**（v0.24.1）：設定頁改成改了就存之後，
 * 使用者在那一頁上換一個模型，頂列的點應該當場變 —— 之前它只在打開 app 時讀一次，
 * 改完設定要重新整理才會對，而一顆說錯話的狀態點比沒有還糟。
 */
export type ModelState = 'ready' | 'none' | 'problem';

/** 一個任務都沒設定 → 空心；設了但有一個跑不動（連不上、缺能力）→ 虛線；否則實心。 */
export function modelStateOf(payload: ProvidersPayload): ModelState {
  const configured = payload.tasks.filter((row) => row.state !== 'not-configured');
  if (configured.length === 0) return 'none';
  return configured.every((row) => row.ok) ? 'ready' : 'problem';
}

export const useModelStateStore = defineStore('model-state', () => {
  const state = ref<ModelState>('none');

  /** 讀 `/api/providers` —— 那一支不會產生費用（CLI 只跑 `--version`、HTTP 連線只列模型）。 */
  async function refresh(): Promise<void> {
    const r = await api.providers();
    if (r.ok) state.value = modelStateOf(r.data);
  }

  /** 設定頁手上已經有最新的一份（讀進來或剛存完），直接用它，不再多打一次。 */
  function setFrom(payload: ProvidersPayload): void {
    state.value = modelStateOf(payload);
  }

  return { state, refresh, setFrom };
});

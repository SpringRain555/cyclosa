import { defineStore } from 'pinia';
import { ref } from 'vue';

import { api } from '../api';

/**
 * 目前打開的是哪個專題。
 *
 * **頂列要顯示專題名，而三個分頁都在同一條頂列上** ——
 * 所以這個名字要跨頁存在，不能由每一頁各自去查（`ui-workflows.md`）。
 */
export const useCaseStore = defineStore('case', () => {
  const slug = ref('');
  const name = ref('');

  async function open(next: string): Promise<void> {
    if (slug.value === next && name.value.length > 0) return;
    slug.value = next;
    // 名稱查不到時就顯示 slug —— **頂列不該因為一次查詢失敗而空掉**
    name.value = next;
    const list = await api.cases();
    if (!list.ok) return;
    const found = list.data.find((c) => c.slug === next);
    if (found !== undefined) name.value = found.name;
  }

  function clear(): void {
    slug.value = '';
    name.value = '';
  }

  return { slug, name, open, clear };
});

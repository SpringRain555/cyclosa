import { defineStore } from 'pinia';
import { ref } from 'vue';

import { api } from '../api';

export const useTranslationStore = defineStore('translation', () => {
  const translated = ref(false);
  const details = new Map<string, ReturnType<typeof api.item>>();

  function item(slug: string, itemId: string, digestedAt: number | null) {
    const key = JSON.stringify([slug, itemId, digestedAt]);
    const existing = details.get(key);
    if (existing !== undefined) return existing;
    const pending = api.item(slug, itemId).then((result) => {
      if (!result.ok) details.delete(key);
      return result;
    });
    details.set(key, pending);
    return pending;
  }

  return { translated, item };
});

import { computed, watch } from 'vue';
import type { Router } from 'vue-router';
import type { useGraphStore } from './stores/graph-store.js';

/** 網址輸入與使用者換焦點共用這一處，避免 replace 又把同一屏載一次。 */
export function useGraphFocusRoute(store: ReturnType<typeof useGraphStore>, router: Router): void {
  const route = router.currentRoute;
  const slug = computed(() => String(route.value.params['slug'] ?? ''));
  const focus = computed(() => {
    const raw = route.value.query['focus'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
  const edge = computed(() => {
    const raw = route.value.query['edge'];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  });
  let openedCase: string | null = null;
  let applyingRoute = false;
  let revision = 0;

  async function writeFocus(): Promise<void> {
    if (applyingRoute || slug.value.length === 0 || store.slug !== slug.value) return;
    if (store.focusQuery === focus.value) return;
    const query = { ...route.value.query };
    if (store.focusQuery === null) delete query['focus'];
    else query['focus'] = store.focusQuery;
    // 舊深層連結的關聯不應在換焦點後重新開啟；其他查詢參數原樣保留。
    delete query['edge'];
    await router.replace({ query });
  }

  watch(
    [slug, focus, edge],
    async ([next, wanted, wantedEdge]) => {
      if (next.length === 0) return;
      const current = ++revision;
      applyingRoute = true;
      try {
        // 首次進頁仍重查；之後相同專題且 focusQuery 相符，就是已載入或正載入的焦點。
        // 因此 store 寫回的 replace 不會再呼叫 open／reload，搜尋選取與裁決面板也不會被重設。
        if (openedCase !== next) {
          openedCase = next;
          await store.open(next, wanted);
        } else if (store.focusQuery !== wanted) {
          if (wanted === null) await store.resetFocus();
          else await store.open(next, wanted);
        }
        if (current === revision && wantedEdge !== null) await store.openEdge(wantedEdge);
      } finally {
        if (current === revision) {
          applyingRoute = false;
          void writeFocus();
        }
      }
    },
    { immediate: true },
  );
  watch(
    () => [store.slug, store.focusQuery],
    () => void writeFocus(),
  );
}

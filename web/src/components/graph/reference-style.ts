export const REFERENCE_FILL_OPACITY = 0.12;

// 只為截圖比較；使用者挑完之後刪掉另一種。
export function referenceStyle(search = window.location.search): 'a' | 'b' {
  return new URLSearchParams(search).get('refStyle') === 'b' ? 'b' : 'a';
}

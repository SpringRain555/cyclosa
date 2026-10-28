/**
 * 「跳到下一條待查證」挑哪一條（2026-10-28 試用回饋 10）。
 *
 * 原本永遠取佇列的第一條 —— 沒裁決之前按「下一條」只會回到同一條，想先跳過一條沒辦法。
 *
 * | 現在開著的那一條 | 下一條 |
 * |---|---|
 * | 還在佇列裡（沒裁決、跳過）| 它的下一條，到尾巴繞回第一條 |
 * | 不在了（剛裁決掉，佇列重讀過）| **原本那個位置上的**那一條 —— 也就是排在它後面的那一條 |
 * | 沒有（第一次按）| 第一條 |
 *
 * 純函式：store 只負責記住上一次跳到第幾條。
 */
export function nextPendingIndex(
  ids: readonly string[],
  currentId: string | null,
  lastIndex: number,
): number | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  if (at >= 0) return (at + 1) % ids.length;
  if (lastIndex >= 0) return Math.min(lastIndex, ids.length - 1);
  return 0;
}

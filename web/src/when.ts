export function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('zh-Hant');
}

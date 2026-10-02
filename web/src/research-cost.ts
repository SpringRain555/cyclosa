import type { Research } from './api.js';
import { fill, t } from './i18n/zh-TW.js';

export function costBreakdown(byTask: Research['costByTask']): string {
  const order = Object.keys(t.research.costTasks) as (keyof typeof t.research.costTasks)[];
  const parts: string[] = [];
  for (const task of order) {
    const cost = byTask[task];
    if (cost === undefined) continue;
    if (cost.requests === 0 && cost.unpriced === 0 && (cost.costUsd ?? 0) === 0) continue;
    const name = t.research.costTasks[task];
    parts.push(
      cost.costUsd === null
        ? fill(t.research.costTaskUnknown, { task: name })
        : fill(t.research.costTaskItem, { task: name, usd: cost.costUsd.toFixed(2) }),
    );
    if (cost.costUsd !== null && cost.unpriced > 0) {
      parts.push(fill(t.research.costTaskUnpriced, { task: name, n: cost.unpriced }));
    }
  }
  return parts.length === 0 ? '' : fill(t.research.costBreakdown, { parts: parts.join('、') });
}

/** 卸載本機模型，不關閉 Ollama 服務。 */
import type { ModelTask } from '../../domain/provider/index.js';
import { logger } from '../../shared/log.js';
import type { ProvidersConfig } from './config.js';
import { authHeader } from './http.js';

export interface ReleaseOptions {
  /**
   * 卸哪幾個任務的模型。**預設是整理用的兩個**（規劃、嵌入）：整理收尾時抽取那一個可能還在別的作業裡用。
   * 關閉 Cyclosa 時傳全部（2026-10-28 試用回饋 13）。
   */
  readonly tasks?: readonly ModelTask[];
  /** 一個請求最多等多久。關閉序列裡要塞進 `closeMs` 的上限，所以比平常短。 */
  readonly timeoutMs?: number;
}

const DEFAULT_TASKS: readonly ModelTask[] = ['plan', 'embed'];

export async function releaseOllamaModels(
  config: ProvidersConfig,
  options: ReleaseOptions = {},
): Promise<void> {
  const connection = config.connections.ollama;
  const tasks = options.tasks ?? DEFAULT_TASKS;
  const models = new Set(
    tasks
      .filter((task) => config.tasks[task].via === 'ollama')
      .map((task) => config.tasks[task].model.trim())
      .filter(Boolean),
  );
  await Promise.all(
    [...models].map(async (model) => {
      try {
        const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/api/generate`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeader(connection.apiKeyEnv, process.env),
          },
          body: JSON.stringify({ model, keep_alive: 0, stream: false }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
        await response.body?.cancel();
        if (!response.ok) logger.warn('Ollama 模型卸載失敗', { status: response.status });
      } catch {
        // 服務無法連線時仍保留已放棄狀態，卸載失敗留在日誌。
        logger.warn('Ollama 模型卸載失敗：服務無法連線');
      }
    }),
  );
}

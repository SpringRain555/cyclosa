/** 卸載這次整理使用的本機模型，不關閉 Ollama 服務。 */
import { logger } from '../../shared/log.js';
import type { ProvidersConfig } from './config.js';
import { authHeader } from './http.js';

export async function releaseOllamaModels(config: ProvidersConfig): Promise<void> {
  const connection = config.connections.ollama;
  const models = new Set(
    (['plan', 'embed'] as const)
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
          signal: AbortSignal.timeout(5000),
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

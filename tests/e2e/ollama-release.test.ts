import { afterEach, expect, it, vi } from 'vitest';
import { releaseOllamaModels } from '../../src/infrastructure/providers/ollama-release.js';
import { DEFAULT_CONFIG } from '../../src/infrastructure/providers/config.js';

afterEach(() => vi.unstubAllGlobals());

it('unloads only the configured local workflow models with a bounded request', async () => {
  const request = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', request);
  await releaseOllamaModels({
    ...DEFAULT_CONFIG,
    tasks: {
      ...DEFAULT_CONFIG.tasks,
      plan: { via: 'ollama', model: 'local-chat' },
      embed: { via: 'ollama', model: 'local-embed' },
      extract: { via: 'ollama', model: 'unrelated-extract' },
    },
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    request.mock.calls.map((args) =>
      JSON.parse((args as unknown as [string, RequestInit])[1].body as string),
    ),
  ).toEqual([
    { model: 'local-chat', keep_alive: 0, stream: false },
    { model: 'local-embed', keep_alive: 0, stream: false },
  ]);
});

it('does not call Ollama for unset tasks or a remote planning model', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await releaseOllamaModels({
    ...DEFAULT_CONFIG,
    tasks: { ...DEFAULT_CONFIG.tasks, plan: { via: 'openai', model: 'remote' } },
  });
  expect(request).not.toHaveBeenCalled();
});

it('關閉 Cyclosa 時傳全部任務：走 Ollama 的每一個模型都卸，同一個模型只卸一次（2026-10-28 試用回饋 13）', async () => {
  const request = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', request);
  await releaseOllamaModels(
    {
      ...DEFAULT_CONFIG,
      tasks: {
        ...DEFAULT_CONFIG.tasks,
        plan: { via: 'openai', model: 'remote' },
        digest: { via: 'ollama', model: 'local-chat' },
        extract: { via: 'ollama', model: 'local-chat' },
        embed: { via: 'ollama', model: 'local-embed' },
      },
    },
    { tasks: ['plan', 'find-sources', 'digest', 'extract', 'embed'], timeoutMs: 1_000 },
  );
  expect(
    request.mock.calls
      .map((args) => JSON.parse((args as unknown as [string, RequestInit])[1].body as string))
      .map((body: { model: string }) => body.model)
      .sort(),
  ).toEqual(['local-chat', 'local-embed']);
});

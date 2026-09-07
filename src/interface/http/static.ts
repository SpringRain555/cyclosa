/**
 * 前端靜態檔。
 *
 * **刻意不引 `@fastify/static`**：它是 MIT（2026-09-06 實查，可用），
 * 但為了服務一個 SPA 目錄要拉 7 個傳遞依賴，
 * 而這裡要做的事只有「回一個檔，或回 index.html」。
 * 同一個理由否掉過 `jsdom`（`environment/versions.md`）。
 *
 * **代價寫在這裡**：路徑圍堵要自己做對。下面那條 `resolve` ＋ 前綴檢查就是它，
 * 而 `tests/interface/static.test.ts` 用真實的穿越字串驗過。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 把一個請求路徑安全地解析到 `root` 底下。
 *
 * **回 `null` 就是拒絕。** 三種要擋的：`..` 穿越、絕對路徑、
 * 以及「解析後不在 root 底下」—— 最後這條是唯一真正可靠的檢查，
 * 前兩條只是讓意圖明顯。
 */
export function safeResolve(root: string, requestPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(requestPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null) return null;
  if (decoded.includes('\0')) return null;

  const rootAbs = resolve(root);
  const target = resolve(rootAbs, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));

  // **前綴要帶分隔符號**，否則 `/data-root-evil` 會被當成在 `/data-root` 底下
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

export function registerStatic(app: FastifyInstance, webRoot: string): void {
  app.setNotFoundHandler(async (req, reply) => {
    // API 的 404 就是 404，不要回 index.html —— 那會讓前端拿到一坨 HTML
    // 然後在 JSON.parse 時炸掉，而錯誤訊息完全看不出真正的原因。
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '找不到這個端點' });
    }

    const target = safeResolve(webRoot, req.url.split('?')[0] ?? '/');
    if (target !== null) {
      try {
        const info = await stat(target);
        if (info.isFile()) {
          return reply
            .type(MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
            .send(createReadStream(target));
        }
      } catch {
        // 落到下面的 index.html
      }
    }

    // SPA 後備：路由由前端處理
    const index = join(resolve(webRoot), 'index.html');
    try {
      await stat(index);
      return reply.type(MIME['.html'] as string).send(createReadStream(index));
    } catch {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('前端還沒有 build。先跑 npm run build:web，或用 npm run dev。');
    }
  });
}

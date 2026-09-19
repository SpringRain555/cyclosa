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
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // pdf.js 的 worker 是 `.mjs`，以 module worker 載入 —— MIME 不是 JavaScript 的話瀏覽器拒絕執行（v0.24.1）。
  '.mjs': 'text/javascript; charset=utf-8',
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

/**
 * pdf.js 在瀏覽器裡畫 PDF 時另外要的資料檔（v0.24.1，閱讀器的「版面」檢視）：
 *
 * | 資料夾 | 什麼時候要 |
 * |---|---|
 * | `cmaps` | 用內建編碼、沒有內嵌字型的中日韓 PDF —— 少了它字會變成亂碼或空白 |
 * | `standard_fonts` | 沒有內嵌的標準十四種字型（Times、Helvetica…）|
 * | `wasm` | 解 JPEG 2000 與 JBIG2 影像 —— 論文裡的圖常常是這兩種，少了它圖是一塊空白 |
 * | `iccs` | 色彩描述檔 |
 *
 * **直接從裝好的 `pdfjs-dist` 給，不複製進建置產物** —— 前端打包的 pdf.js 跟這裡是同一個套件
 * （同一份 `package.json`），版本永遠一致；複製一份的話兩邊可以各自過期。
 *
 * 只給這四個資料夾、檔名只准英數與 `._-`，再過一次 `safeResolve`。
 * 放在 `/pdfjs/` 而不是 `/api/`：它們不是 API，是靜態檔（`vite.config.ts` 的 dev proxy 也轉這一條）。
 */
export const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

const PDFJS_MIME: Readonly<Record<string, string>> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
};

/** 裝好的 `pdfjs-dist` 在哪。它沒有 `exports` 欄位，所以 `package.json` 解得到。 */
export function pdfjsRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
}

export function registerPdfjsAssets(app: FastifyInstance, root: string): void {
  app.get<{ Params: { dir: string; file: string } }>('/pdfjs/:dir/:file', async (req, reply) => {
    const { dir, file } = req.params;
    const allowed = (PDFJS_ASSET_DIRS as readonly string[]).includes(dir);
    const target =
      allowed && /^[A-Za-z0-9._-]+$/.test(file) ? safeResolve(join(root, dir), file) : null;
    if (target !== null) {
      try {
        const info = await stat(target);
        if (info.isFile()) {
          return reply
            .type(PDFJS_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
            .header('cache-control', 'no-cache')
            .send(createReadStream(target));
        }
      } catch {
        // 落到下面的 404
      }
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('not found');
  });
}

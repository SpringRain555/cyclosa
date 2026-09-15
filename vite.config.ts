import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 前端建置。
 *
 * `root` 指到 `web/`，產出到 `web/dist` —— 後端把那個資料夾當靜態根。
 * dev 時 `/api` 與 `/healthz` proxy 到 7433 的 server，
 * **所以開發與正式跑的是同一組路徑**，不必在前端分兩套。
 */
export default defineConfig({
  root: 'web',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      // **前端也要用的純規則從 `domain/` 直接引，不複製一份。**
      // 只有零 I/O 的純函式可以走這條路（`domain/graph` 連 npm 套件都不 import）——
      // 一份規則兩個實作，遲早會分岔，而分岔的那一份會安靜地給出錯的答案。
      // 這兩個別名在 `tsconfig.web.json` 裡從 v0.1.0 就宣告好了。
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7433',
      '/healthz': 'http://127.0.0.1:7433',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

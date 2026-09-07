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

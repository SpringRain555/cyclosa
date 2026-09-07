import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { createPinia } from 'pinia';

import App from './App.vue';
import CaseListView from './views/CaseListView.vue';
import ReaderView from './views/ReaderView.vue';
import RunsView from './views/RunsView.vue';
import './styles/tokens.css';

/**
 * **專題清單是最上層，沒有分頁。** 進到一個專題之後才有分頁。
 *
 * **`關聯圖` 是主畫面**，所以 `/case/:slug` 直接落在它上面 ——
 * 「清單 → 開啟專題 → 關聯圖」是設計稿五條跳轉路徑的第一條。
 *
 * > 元件叫 `CaseGraphView`，而**它包住的那一層抽象叫 `GraphView`**
 * > （`components/graph/GraphView.vue`）。兩個名字都是文件定的：
 * > 前者跟其他頁一樣是 `*View`，後者是 ADR-0007 那層抽象的名字。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'cases', component: CaseListView },
    /**
     * **關聯圖這一頁是動態載入的。**
     *
     * three.js 是 1.4 MB，而第一個畫面是專題清單 —— 那一頁不需要 3D。
     * 靜態 import 的話，使用者要等整包下載完才看得到清單。
     */
    { path: '/case/:slug', name: 'graph', component: () => import('./views/CaseGraphView.vue') },
    { path: '/case/:slug/graph', redirect: (to) => `/case/${String(to.params['slug'])}` },
    { path: '/case/:slug/reader/:itemId?', name: 'reader', component: ReaderView },
    { path: '/case/:slug/runs/:runId?', name: 'runs', component: RunsView },
    // 找不到的路由回清單
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App).use(createPinia()).use(router).mount('#app');

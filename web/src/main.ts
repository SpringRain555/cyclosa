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
 * `關聯圖` 的路由不在這裡 —— Stage 7 才會有。**不先佔一個位子**：
 * 一個指向空白頁的路由跟一個壞掉的連結長得一樣。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'cases', component: CaseListView },
    { path: '/case/:slug/reader/:itemId?', name: 'reader', component: ReaderView },
    { path: '/case/:slug/runs/:runId?', name: 'runs', component: RunsView },
    // 找不到的路由回清單
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App).use(createPinia()).use(router).mount('#app');

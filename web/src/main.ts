import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { createPinia } from 'pinia';

import App from './App.vue';
import CaseListView from './views/CaseListView.vue';
import './styles/tokens.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'cases', component: CaseListView },
    // 找不到的路由回清單 —— 這一版只有這一頁
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App).use(createPinia()).use(router).mount('#app');

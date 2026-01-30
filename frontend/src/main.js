import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';

import App from './App.vue';
import routes, { setupRouterGuards } from './router';
import { useUserStore } from '@/store/user';
import { getUserInfo } from '@/api/user';

import './styles/global.css';

const pinia = createPinia();

const router = createRouter({
  history: createWebHistory(),
  routes
});

// 挂载路由守卫
setupRouterGuards(router);

const app = createApp(App);

app.use(pinia);
app.use(router);

app.mount('#app');

// 启动后尝试从后端刷新一次当前用户信息（包含最新 role）
const userStore = useUserStore();
if (userStore.token) {
  getUserInfo()
    .then((res) => {
      const latest = res.data || {};
      // 保留原有字段，覆盖成后端的最新信息（尤其是 role）
      const mergedUser = {
        ...(userStore.user || {}),
        ...latest
      };
      userStore.setAuth(userStore.token, mergedUser);
    })
    .catch(() => {
      // 忽略刷新失败，保持原有本地状态
    });
}


import axios from 'axios';
import { useUserStore } from '@/store/user';

const instance = axios.create({
  baseURL: '/api',
  timeout: 10000
});

instance.interceptors.request.use(
  (config) => {
    const userStore = useUserStore();
    if (userStore.token) {
      config.headers.Authorization = `Bearer ${userStore.token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

instance.interceptors.response.use(
  (response) => {
    const data = response.data;
    if (data && data.code !== 200) {
      return Promise.reject(new Error(data.message || '请求失败'));
    }
    return data;
  },
  (error) => {
    if (error.response) {
      const { status, data } = error.response;
      const userStore = useUserStore();
      // 未登录或 Token 失效
      if (status === 401) {
        userStore.logout();
        window.location.href = '/auth/login';
        return Promise.reject(error);
      }
      // 账户被停用：后端返回 403 + code 403 + message 内含「停用」
      if (
        status === 403 &&
        data &&
        (data.code === 403 || data.code === '403') &&
        typeof data.message === 'string' &&
        data.message.includes('停用')
      ) {
        alert('账户已被封禁');
        userStore.logout();
        window.location.href = '/auth/login';
        return Promise.reject(error);
      }

      // 其它非 200：优先透传后端 message，避免前端只看到 “Request failed with status code 400”
      if (data && typeof data.message === 'string' && data.message) {
        return Promise.reject(new Error(data.message));
      }
    }
    return Promise.reject(error);
  }
);

export default instance;


import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['jinkecheng.icbc.press'],
    proxy: {
      // Docker 内用 BACKEND_URL（http://backend:3000），本机开发用 localhost:3000
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
});


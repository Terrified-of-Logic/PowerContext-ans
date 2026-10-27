import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // 前端 /api 转发到本地 Node 后端
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
  },
});

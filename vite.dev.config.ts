import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const __root = import.meta.dirname;

// 本地开发页：模拟酒馆环境，运行真实后端 + 面板 + 状态条（需先 npm run build 生成面板 HTML）
export default defineConfig({
  root: resolve(__root, 'dev'),
  server: { port: 5174, host: '0.0.0.0', allowedHosts: true, fs: { allow: [__root] } },
  preview: { port: 5174, host: '0.0.0.0', allowedHosts: true },
  build: { outDir: resolve(__root, 'dist/.dev'), emptyOutDir: true, target: 'es2020' },
});

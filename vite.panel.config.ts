import { resolve } from 'node:path';

const __root = import.meta.dirname;
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 悬浮管理面板：打包成单个 HTML 文件（Vue + 样式全部内联），由后端脚本作为 iframe srcdoc 注入酒馆页面。
export default defineConfig({
  root: resolve(__root, 'src/ui/panel'),
  base: './',
  plugins: [vue(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: { alias: { '@engine': resolve(__root, 'src/engine') } },
  define: { __VUE_PROD_DEVTOOLS__: false, __VUE_OPTIONS_API__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  build: {
    outDir: resolve(__root, 'dist/.panel'),
    emptyOutDir: true,
    target: 'es2020',
    minify: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
  },
  server: { port: 5173, host: '0.0.0.0' },
});

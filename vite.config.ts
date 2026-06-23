import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client only ever fetches the pre-built static quality_data.json mock.
// No API credentials live in the client build (NFR-02: credential masking).
export default defineConfig({
  // 상대 경로 빌드 → GitHub Pages 프로젝트 서브경로(/<repo>/)에서도 자산이 올바로 로드됨.
  base: './',
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: 'dist', sourcemap: false },
});

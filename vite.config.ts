import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client only ever fetches the pre-built static quality_data.json mock.
// No API credentials live in the client build (NFR-02: credential masking).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: 'dist', sourcemap: false },
});

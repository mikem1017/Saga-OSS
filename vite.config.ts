import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/web'),
  publicDir: r('./public'),
  plugins: [react(), tailwindcss()],
  build: { outDir: r('./dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/ical': 'http://localhost:3000' },
  },
});

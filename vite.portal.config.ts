import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The public request portal is a separate build (dist/portal) so the portal container never serves admin code.
export default defineConfig({
  root: r('./src/web/portal'),
  publicDir: r('./public-portal'),
  plugins: [react(), tailwindcss()],
  build: { outDir: r('./dist/portal'), emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5174,
    proxy: { '/api/portal': 'http://localhost:3002' },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
    dedupe: ['@codemirror/state', '@codemirror/view'],
  },
  optimizeDeps: {
    include: ['@codemirror/state', '@codemirror/view', 'yjs', 'y-codemirror.next'],
  },
  server: {
    port: 5173,
  },
});

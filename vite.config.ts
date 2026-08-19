import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from a bare port-forward with no domain, so every asset reference is
  // relative. An absolute "/assets/..." breaks the moment the app is mounted
  // under a path prefix by an ingress.
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});

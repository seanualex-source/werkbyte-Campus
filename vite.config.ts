import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri erwartet einen festen Port im Entwicklungsmodus und relative Assets im Release.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  base: './',
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 60000,
  },
} as any);

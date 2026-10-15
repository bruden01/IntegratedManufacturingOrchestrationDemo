import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const namespace = env.VANTIQ_NAMESPACE || env.VITE_VANTIQ_NAMESPACE;

  if (mode === 'vantiq' && !namespace) {
    throw new Error('VITE_VANTIQ_NAMESPACE must be set for a --mode vantiq build');
  }

  return {
    // A Vantiq-hosted build is served from /ui/docs/NS/<namespace>/web/; dev and preview serve from /.
    base: mode === 'vantiq' ? `/ui/docs/NS/${namespace}/web/` : '/',
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      // Same-origin from the browser's point of view, so no CORS on Vantiq REST calls in dev.
      proxy: {
        '/api': {
          target: env.VITE_VANTIQ_URL,
          changeOrigin: true,
          secure: true,
          ws: true,
        },
      },
    },
  };
});

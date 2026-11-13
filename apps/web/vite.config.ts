import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The support app (ADR 0018). `vite build` writes a static bundle to dist/, which the image's
// static server serves; the API and IdP origins are not in the bundle but in /config.js, which
// that server writes from its environment at runtime.
export default defineConfig({
  plugins: [react()],
  build: {
    // No inline scripts or styles: the CSP allows only files from the app's own origin.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});

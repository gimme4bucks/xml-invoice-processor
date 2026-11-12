import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// unplugin-swc is needed because Vite's esbuild does not emit decorator metadata,
// which NestJS dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
        },
      },
      {
        // Port contract suites run against real infrastructure (Postgres, RabbitMQ).
        extends: true,
        test: {
          name: 'contract',
          include: ['test/contract/**/*.contract.spec.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.spec.ts'],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

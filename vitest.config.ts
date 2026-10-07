import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.gpu.test.ts'],
        },
      },
      {
        test: {
          name: 'gpu',
          include: ['**/*.gpu.test.ts'],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: false, // real GPU; headless Chrome may lack a WebGPU adapter
            instances: [
              { browser: 'chromium', launch: { channel: 'chrome', args: ['--enable-unsafe-webgpu'] } },
            ],
          },
        },
      },
    ],
  },
});

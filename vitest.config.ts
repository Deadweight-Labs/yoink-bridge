import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// The template imports the SDK as `yoink-bridge`, as a deployed copy does
// from npm; here those imports run against src/.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^yoink-bridge$/, replacement: src('index.ts') },
      { find: /^yoink-bridge\/cloudflare$/, replacement: src('cloudflare/index.ts') },
      { find: /^yoink-bridge\/(.+)$/, replacement: src('$1.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'template/test/**/*.test.ts'],
  },
});

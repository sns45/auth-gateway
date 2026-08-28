import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirrors the `@/*` -> `src/*` mapping in tsconfig.json. Without it Vitest
// cannot resolve the alias at runtime, so any test that imports a module (as
// opposed to a type) from src/ fails to collect.
const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${src}/` }],
  },
  test: {
    environment: 'node',
  },
});

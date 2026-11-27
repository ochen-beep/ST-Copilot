import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Рантайм-модули SillyTavern, которые расширение импортирует по абсолютным
// путям. Rollup считает их external, а Vite в тестах не может разрешить —
// подменяем пустой заглушкой, чтобы граф импортов загружался.
const stStub = fileURLToPath(new URL('./tests/stubs/st-runtime-stub.js', import.meta.url));
const stRuntimePaths = [
  '/scripts/world-info.js',
  '/scripts/utils.js',
  '/scripts/openai.js',
  '/scripts/extensions/image-captioning/index.js',
  '/scripts/extensions/regex/engine.js',
];

export default defineConfig({
  resolve: {
    alias: stRuntimePaths.map(find => ({ find, replacement: stStub })),
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    globals: true,
    setupFiles: ['tests/setup.js'],
    cache: { dir: 'node_modules/.vite' },
  },
});
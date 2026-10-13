import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests of pure modules: *.test.ts only, in Node, without a DOM (AGENTS.md, Frontend).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})

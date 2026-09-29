import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './openapi.json',
  output: { path: './src/api', postProcess: [] },
  plugins: [
    { name: '@hey-api/client-fetch', runtimeConfigPath: './src/lib/api-config.ts' },
    '@hey-api/typescript',
    '@hey-api/sdk',
    '@tanstack/react-query',
  ],
})

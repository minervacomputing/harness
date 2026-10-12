import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    // The SPA and the API share one origin, so session cookies and CSRF work as in production. The Worker
    // checks the Origin header of Better Auth's requests against MINERVA_SITE_URL (this server's origin by
    // default), so the proxy must pass it on unchanged.
    proxy: { '/api': { target: process.env.MINERVA_API_URL ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
})
